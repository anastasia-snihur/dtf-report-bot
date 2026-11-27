import {deadline,escapeHtml,kyivDate,overdue,parseOrder,reactions,reportParts,type Order} from './domain';
import {deliverAuto,TelegramRejection} from './delivery';
interface Env{DB:D1Database;TELEGRAM_BOT_TOKEN:string;TELEGRAM_WEBHOOK_SECRET:string;SOURCE_CHAT_ID:string;REPORT_CHAT_ID:string}
type Message={chat:{id:number};message_id:number;date:number;text?:string;caption?:string;from?:{id:number}};
type Update={update_id:number;message?:Message;edited_message?:Message;message_reaction?:{chat:{id:number};message_id:number;user?:{id:number};actor_chat?:{id:number};new_reaction:{type:string;emoji?:string}[]}};
async function api(env: Env, method: string, params: Record<string, unknown> = {}) {
  let response: Response;
  try {
    response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify(params), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // A fetch error can include the full URL, which contains the secret token.
    throw new Error('Telegram ' + method + ': response not received');
  }
  const data = await response.json().catch(() => null) as {
    ok?: boolean; result?: any; error_code?: number; parameters?: {retry_after?: number};
  } | null;
  if (data?.ok === false) {
    const status = Number.isInteger(data.error_code) ? data.error_code! : response.status;
    const retryAfter = data.parameters?.retry_after;
    throw new TelegramRejection(method, status, Number.isFinite(retryAfter) ? Math.max(0, retryAfter!) : 0);
  }
  if (!response.ok || data?.ok !== true) throw new Error('Telegram ' + method + ': invalid response');
  return data.result;
}
async function state(env:Env,key:string,value:string){await env.DB.prepare('INSERT INTO bot_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,value).run()}
async function error(env:Env,e:unknown){console.error(e);await Promise.allSettled([state(env,'last_error',String(e)),state(env,'sync_warning','1')])}
async function allowed(env:Env,id:number){for(const chat_id of [env.SOURCE_CHAT_ID,env.REPORT_CHAT_ID]){try{const m=await api(env,'getChatMember',{chat_id,user_id:id});if(['creator','administrator','member'].includes(m.status)||(m.status==='restricted'&&m.is_member))return true}catch(e){console.error(e)}}return false}
async function send(env:Env,chat:string,text:string){return api(env,'sendMessage',{chat_id:chat,text,parse_mode:'HTML',disable_web_page_preview:true})}
async function order(env: Env, m: Message, edited: boolean, updateId: number) {
  if (String(m.chat.id) !== env.SOURCE_CHAT_ID) return;
  const parsed = parseOrder(m.text ?? m.caption ?? '');
  if (!parsed) {
    if (edited) {
      const existing = await env.DB.prepare(`SELECT id FROM orders WHERE source_chat_id=?
        AND source_message_id=? AND message_update_id<?`).bind(env.SOURCE_CHAT_ID,m.message_id,updateId).first();
      if (existing) {
        await state(env,'last_error','Edited order ' + m.message_id + ' lost its number');
        await state(env,'sync_warning','1');
      }
    }
    return;
  }
  const now = Math.floor(Date.now()/1000);
  // Read reaction snapshots in the same SQL statement that creates the order.
  await env.DB.prepare(`INSERT INTO orders
    (source_chat_id,source_message_id,order_number,description,published_at,deadline,
      reaction_fire,reaction_heart,reaction_update_id,updated_at,message_update_id)
    SELECT ?,?,?,?,?,?,COALESCE(MAX(fire),0),COALESCE(MAX(heart),0),COALESCE(MAX(update_id),-1),?,?
    FROM actor_reactions WHERE source_chat_id=? AND source_message_id=?
    ON CONFLICT(source_chat_id,source_message_id) DO UPDATE SET
      order_number=excluded.order_number,description=excluded.description,updated_at=excluded.updated_at,
      message_update_id=excluded.message_update_id
    WHERE orders.message_update_id<excluded.message_update_id`)
    .bind(env.SOURCE_CHAT_ID,m.message_id,parsed.number,parsed.description,m.date,deadline(m.date),
      now,updateId,env.SOURCE_CHAT_ID,m.message_id).run();
}
async function reaction(env: Env, u: NonNullable<Update['message_reaction']>, id: number) {
  if (String(u.chat.id) !== env.SOURCE_CHAT_ID) return;
  const actor = u.actor_chat ? 'chat:' + u.actor_chat.id : u.user ? 'user:' + u.user.id : null;
  if (!actor) return;
  const {fire, heart} = reactions(u.new_reaction);
  // Telegram's new_reaction is per actor, not a snapshot of everyone's reactions.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO actor_reactions
      (source_chat_id,source_message_id,actor,fire,heart,update_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(source_chat_id,source_message_id,actor) DO UPDATE SET
        fire=excluded.fire,heart=excluded.heart,update_id=excluded.update_id
      WHERE excluded.update_id>actor_reactions.update_id`)
      .bind(env.SOURCE_CHAT_ID,u.message_id,actor,fire,heart,id),
    env.DB.prepare(`UPDATE orders SET (reaction_fire,reaction_heart,reaction_update_id)=(
      SELECT COALESCE(MAX(fire),0),COALESCE(MAX(heart),0),COALESCE(MAX(update_id),-1)
      FROM actor_reactions WHERE source_chat_id=orders.source_chat_id
        AND source_message_id=orders.source_message_id), updated_at=?
      WHERE source_chat_id=? AND source_message_id=?`)
      .bind(Math.floor(Date.now()/1000),env.SOURCE_CHAT_ID,u.message_id),
  ]);
}
async function publishManual(env: Env, now: Date) {
  const orders = (await env.DB.prepare('SELECT * FROM orders').all<Order>()).results;
  const warning = (await env.DB.prepare("SELECT value FROM bot_state WHERE key='sync_warning'")
    .first<{value:string}>())?.value === '1';
  const parts = reportParts(orders, now, warning);
  const ids: number[] = [];
  const result = await env.DB.prepare(`INSERT INTO report_runs(report_type,local_date,created_at,status)
    VALUES ('manual',?,?,'sending') RETURNING id`)
    .bind(kyivDate(now),Math.floor(now.getTime()/1000)).first<{id:number}>();
  if (!result) throw new Error('Could not reserve manual report');
  try {
    for (const part of parts) {
      const sent = await send(env,env.REPORT_CHAT_ID,part);
      if (!Number.isSafeInteger(sent?.message_id)) throw new Error('Missing Telegram message ID');
      ids.push(sent.message_id);
      await env.DB.prepare('UPDATE report_runs SET message_ids=? WHERE id=?')
        .bind(JSON.stringify(ids),result.id).run();
    }
    await env.DB.prepare("UPDATE report_runs SET status='success' WHERE id=?").bind(result.id).run();
  } catch (e) {
    await env.DB.prepare('UPDATE report_runs SET status=?,message_ids=?,error_message=? WHERE id=?')
      .bind(e instanceof TelegramRejection ? 'failed' : 'uncertain', JSON.stringify(ids),String(e),result.id).run();
    throw e;
  }
}
async function status(env:Env){const all=(await env.DB.prepare('SELECT * FROM orders').all<Order>()).results,today=kyivDate(new Date());const rows=(await env.DB.prepare('SELECT key,value FROM bot_state').all<{key:string;value:string}>()).results,s=Object.fromEntries(rows.map(r=>[r.key,r.value]));const run=await env.DB.prepare("SELECT status,error_message FROM report_runs WHERE report_type='auto' ORDER BY local_date DESC LIMIT 1").first<{status:string;error_message:string|null}>();const statuses:Record<string,string>={queued:'у черзі',sending:'надсилається',retry:'очікує повтору',success:'доставлено',failed:'не доставлено повністю',uncertain:'перевірте вручну в Telegram'};let hook='невідомо';try{hook=(await api(env,'getWebhookInfo')).url?'налаштований':'не налаштований'}catch{hook='помилка перевірки'}return '<b>DTF Report Bot · Стан</b>\nWebhook: '+hook+'\nУсього: '+all.length+'\nНезавершених: '+all.filter(x=>!x.reaction_heart).length+'\nВиконаних: '+all.filter(x=>x.reaction_heart).length+'\nПрострочених: '+all.filter(x=>!x.reaction_heart&&overdue(x.deadline,today)>0).length+'\nОстаннє оновлення: '+escapeHtml(s.last_update||'немає')+'\nОстанній автозвіт: '+escapeHtml(s.last_auto_report||'немає')+(run?'\nСтан автозвіту: '+(statuses[run.status]??run.status):'')+'\nОстання помилка: '+escapeHtml(s.last_error||'немає')}
function insertUpdate(env: Env, id: number) {
  return env.DB.prepare('INSERT OR IGNORE INTO processed_updates(update_id,processed_at) VALUES(?,?)')
    .bind(id,Math.floor(Date.now()/1000));
}
function command(message?: Message) {
  return /^\/(report|status)(?:@\w+)?(?:\s|$)/i.exec(message?.text ?? '')?.[1].toLowerCase();
}
async function handleCommand(env: Env, m: Message, cmd: string) {
  const chat = String(m.chat.id);
  if (![env.SOURCE_CHAT_ID,env.REPORT_CHAT_ID].includes(chat) && chat !== String(m.from?.id)) return;
  if (!m.from || !await allowed(env,m.from.id)) {
    await send(env,chat,'Немає доступу до робочих даних.');
    return;
  }
  if (cmd === 'status') {
    await send(env,chat,await status(env));
  } else {
    await publishManual(env,new Date());
    if (chat !== env.REPORT_CHAT_ID) await send(env,chat,'Звіт опубліковано в групі «Деталі DTF».');
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== '/webhook' || request.method !== 'POST')
      return new Response('Not found',{status:404});
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET)
      return new Response('Forbidden',{status:403});
    let u: Update;
    try {
      u = await request.json() as Update;
      if (!Number.isSafeInteger(u?.update_id) || u.update_id < 0) throw new Error('Invalid update_id');
    } catch {
      return new Response('Bad JSON',{status:400});
    }
    try {
      const cmd = command(u.message);
      if (cmd && u.message) {
        // Claim first: a retried webhook must never post a second manual report.
        if ((await insertUpdate(env,u.update_id).run()).meta.changes) {
          try { await handleCommand(env,u.message,cmd); }
          catch (e) {
            await error(env,e);
            const chat = String(u.message.chat.id);
            if ([env.SOURCE_CHAT_ID, env.REPORT_CHAT_ID].includes(chat) || chat === String(u.message.from?.id)) {
              await send(env,chat,'Не вдалося підтвердити виконання команди. Перед повтором перевірте чат зі звітами.')
                .catch(() => undefined);
            }
          }
          await state(env,'last_update',new Date().toISOString());
        }
      } else if (!await env.DB.prepare('SELECT update_id FROM processed_updates WHERE update_id=?').bind(u.update_id).first()) {
        // The writes below are idempotent and safe to repeat after a partial failure.
        const m = u.message ?? u.edited_message;
        if (m && !command(m)) await order(env,m,!!u.edited_message,u.update_id);
        if (u.message_reaction) await reaction(env,u.message_reaction,u.update_id);
        await state(env,'last_update',new Date().toISOString());
        await insertUpdate(env,u.update_id).run();
      }
      return new Response('OK');
    } catch (e) {
      await error(env,e);
      return new Response('Retry later',{status:503});
    }
  },
  async scheduled(_event: ScheduledController, env: Env) {
    try { await deliverAuto(env.DB,new Date(),part => send(env,env.REPORT_CHAT_ID,part)); }
    catch (e) { await error(env,e); }
  },
} satisfies ExportedHandler<Env>;
