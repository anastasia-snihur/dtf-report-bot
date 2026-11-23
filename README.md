# DTF Report Bot

Independent TypeScript Telegram bot built with Cloudflare Workers, D1 and Cron Triggers. This project does not modify DTF Plan Bot.

## GitHub Codespaces

1. Open branch `feat/dtf-report-worker` in Codespaces.
2. Run `npm install`, `npm test`, `npm run typecheck`.
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

Cron runs at 13:50 and 14:50 UTC, but only publishes at 16:50 Europe/Kyiv on weekdays. Automatic reports are reserved once per local date.

## Known limitations

Telegram Bot API cannot retrieve arbitrary old messages or reactions. Only updates received after activation are tracked. Network failures after Telegram accepts a message can leave an uncertain send state. Do not deploy for production without verifying D1 migrations, concurrent webhook handling, report pagination, actual Telegram reaction behavior, and Cloudflare Cron execution.

**Status: initial implementation committed, not yet integration-tested or deployed.**
