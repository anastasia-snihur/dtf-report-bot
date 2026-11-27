import {kyivDate, kyivParts, reportParts, shouldRun, type Order} from './domain';

export class TelegramRejection extends Error {
  constructor(
    method: string,
    readonly status: number,
    readonly retryAfter: number = 0,
  ) {
    super('Telegram ' + method + ' rejected the request (' + status + ')');
  }
}

type Sender = (part: string) => Promise<{message_id: number}>;
type Run = {
  id: number; status: string; parts: string | null; message_ids: string;
  next_part: number; part_attempts: number; next_attempt_at: number;
};
const MAX_ATTEMPTS = 3;
const STALE_SECONDS = 10 * 60;

export function inDeliveryWindow(date: Date) {
  const p = kyivParts(date);
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return !['Sat', 'Sun'].includes(p.weekday) && minute >= 16 * 60 + 50 && minute <= 17 * 60 + 30;
}

export async function deliverAuto(
  db: D1Database, now: Date, send: Sender, clock: () => number = Date.now,
) {
  const day = kyivDate(now);
  const p = kyivParts(now);
  const minute = Number(p.hour) * 60 + Number(p.minute);
  const seconds = () => Math.floor(clock() / 1000);

  // An interrupted claim has an unknown delivery outcome. Never resend it blindly.
  // Any retry window that closed without success is visible in report history.
  await db.batch([
    db.prepare(`UPDATE report_runs SET status='uncertain',
        error_message='Delivery was interrupted; verify the report in Telegram'
        WHERE report_type='auto' AND status='sending' AND parts IS NOT NULL AND claim_at <= ?`)
      .bind(seconds() - STALE_SECONDS),
    db.prepare(`UPDATE report_runs SET status='failed',
        error_message=COALESCE(error_message,'Retry window closed before all parts were sent')
        WHERE report_type='auto' AND status IN ('queued','retry')
          AND (local_date < ? OR (local_date = ? AND (? = 1 OR (? = 1 AND next_part=0))))`)
      .bind(day, day, Number(minute > 17 * 60 + 30), Number(minute > 16 * 60 + 50)),
  ]);
  if (!inDeliveryWindow(now)) return;

  const lookup = () => db.prepare("SELECT * FROM report_runs WHERE report_type='auto' AND local_date=?")
    .bind(day).first<Run>();
  let run = await lookup();
  if (!run) {
    if (!shouldRun(now)) return;
    const orders = (await db.prepare('SELECT * FROM orders').all<Order>()).results;
    const warning = (await db.prepare("SELECT value FROM bot_state WHERE key='sync_warning'")
      .first<{value: string}>())?.value === '1';
    const parts = reportParts(orders, now, warning);
    await db.prepare(`INSERT OR IGNORE INTO report_runs
      (report_type,local_date,created_at,status,parts) VALUES ('auto',?,?,'queued',?)`)
      .bind(day, seconds(), JSON.stringify(parts)).run();
    run = await lookup();
  }
  // A pre-upgrade row lacks a snapshot. Do not reconstruct and resend it.
  if (!run?.parts) return;
  const parts = JSON.parse(run.parts) as string[];
  for (let i = 0; i < 12 && run; i++) {
    if (!inDeliveryWindow(new Date(clock()))) return;
    const {id, next_part: part, part_attempts: attempts, status} = run;
    if (part === 0 && !shouldRun(new Date(clock()))) return;
    if (!['queued', 'retry'].includes(status) || run.next_attempt_at > seconds()) return;
    const claim = seconds();
    const claimed = await db.prepare(`UPDATE report_runs SET status='sending',
      part_attempts=part_attempts+1, claim_at=? WHERE id=? AND status=? AND next_part=?
      AND part_attempts=? AND next_attempt_at<=?`)
      .bind(claim, id, status, part, attempts, claim).run();
    if (!claimed.meta.changes) return;

    let received: {message_id: number};
    try {
      received = await send(parts[part]);
      if (!Number.isSafeInteger(received.message_id)) throw new Error('Missing Telegram message ID');
    } catch (e) {
      const rejected = e instanceof TelegramRejection;
      const transient = rejected && (e.status === 429 || e.status >= 500);
      const retry = transient && part > 0 && attempts + 1 < MAX_ATTEMPTS;
      const outcome = retry ? 'retry' : rejected ? 'failed' : 'uncertain';
      const detail = rejected ? e.message : 'Telegram delivery could not be confirmed; verify in the report chat';
      await db.prepare(`UPDATE report_runs SET status=?,error_message=?,next_attempt_at=?,claim_at=NULL
        WHERE id=? AND status='sending' AND claim_at=?`)
        .bind(outcome, detail, retry ? seconds() + Math.max(60, e.retryAfter) : 0, id, claim).run();
      return;
    }

    const ids = [...JSON.parse(run.message_ids) as number[], received.message_id];
    const done = part + 1 === parts.length;
    const saved = await db.prepare(`UPDATE report_runs SET status=?,next_part=?,message_ids=?,
      part_attempts=0,next_attempt_at=0,claim_at=NULL,error_message=NULL
      WHERE id=? AND status='sending' AND claim_at=?`)
      .bind(done ? 'success' : 'queued', part + 1, JSON.stringify(ids), id, claim).run();
    if (!saved.meta.changes) return;
    if (done) {
      await db.prepare(`INSERT INTO bot_state(key,value) VALUES('last_auto_report',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .bind(new Date(clock()).toISOString()).run();
      return;
    }
    run = await lookup();
  }
}
