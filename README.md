# DTF Report Bot

Independent TypeScript Telegram bot built with Cloudflare Workers, D1 and Cron Triggers. This project does not modify DTF Plan Bot.

## GitHub Codespaces

1. Open branch `feat/dtf-report-worker` in Codespaces.
2. Run `npm ci`, `npm test`, `npm run typecheck`.
3. Create a **new** bot with @BotFather.
4. Run `npx wrangler login`.
5. Run `npx wrangler d1 create dtf-report-db` and copy the returned ID into `wrangler.toml`.
6. Run `npm run db:local` for local D1, or `npm run db:remote` for production.
7. Run `npx wrangler secret put TELEGRAM_BOT_TOKEN` and `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`.
8. Set `SOURCE_CHAT_ID` and `REPORT_CHAT_ID` in Worker environment variables.
9. Run `npm run deploy`.

Use `.dev.vars` for local secrets (ignored by git). The source bot must be administrator in DTF for reaction updates and must receive ordinary group messages. The report bot needs posting permission in «Деталі DTF».

## Configure Telegram webhook

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `WORKER_URL` in your terminal first:

```bash
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" -H 'Content-Type: application/json' -d "{\"url\":\"${WORKER_URL}/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"edited_message\",\"message_reaction\"]}"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" -H 'Content-Type: application/json' -d '{"commands":[{"command":"report","description":"Publish unfinished orders report"},{"command":"status","description":"Show bot diagnostics"}]}'
```

An automatic report starts only at **16:50 Europe/Kyiv on weekdays**. If a report has already sent its first part and Telegram explicitly rejects a later part with a retryable error, the Worker retries only that unsent part, up to two retries per part, until 17:30 Kyiv time. It honors Telegram’s rate-limit delay. Already sent parts are not repeated, and a missed report is never started late or carried over to the next day.

If Telegram's response is missing or ambiguous, the bot does not automatically resend. Check the report chat and `/status` before using `/report` to generate a fresh report. A duplicate delivery of the same manual webhook cannot create a second report.

## Known limitations

Telegram Bot API cannot retrieve arbitrary old messages or reactions. Only updates received after activation are tracked. Network failures after Telegram accepts a message can leave an uncertain send state. Verify actual Telegram reaction behavior and Cloudflare Cron execution in staging before production.

**Status: integration tests run locally with simulated Telegram responses. A live Telegram and Cloudflare staging check is still required.**

## Verify before rollout

Run the following with Node.js 22.13+:

```bash
npm ci
npm run typecheck
npm test
npm run db:local
```

CI tests use a local SQLite database with the actual D1 migrations and fake
Telegram responses. For a staging smoke test, use a **separate Report Bot
token, test groups and test D1 database**. Give the bot administrator access in
both groups so Telegram can reliably verify group membership. Post a message
and photo caption with order numbers, add 🔥 and ❤️ from two accounts, remove
one reaction, and edit an order. Check `/status`, run `/report` from each group
and from a direct message, and confirm that completed orders are excluded
and the report lands only in the configured report group. Check the scheduled
report on a weekday. Do not reuse the DTF Plan Bot token or webhook.

When upgrading an already deployed Report Bot, apply migration 0002 first.
Existing orders remain intact, but Telegram does not supply historical
per-person reactions (or a reliable way to reconstruct them). Verify old
orders manually if they predate this migration.
