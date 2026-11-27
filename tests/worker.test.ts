import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {DatabaseSync as Database} from 'node:sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import worker from '../src/index';
import {deliverAuto, inDeliveryWindow, TelegramRejection} from '../src/delivery';
import {reportParts} from '../src/domain';

const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type Arg = string | number | null;
function localDatabase(sql: Database) {
  const prepare = (query: string, values: Arg[] = []) => ({
    bind: (...args: Arg[]) => prepare(query, args),
    first: async () => sql.prepare(query).get(...values) ?? null,
    all: async () => ({results: sql.prepare(query).all(...values)}),
    run: async () => ({meta: {changes: Number(sql.prepare(query).run(...values).changes)}}),
  });
  return {
    prepare,
    batch: async (stmts: ReturnType<typeof prepare>[]) => {
      sql.exec('BEGIN');
      try {
        const results = await Promise.all(stmts.map(stmt => stmt.run()));
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
let sql: Database;
let db: D1Database;
const start = Date.UTC(2026,10,27,14,50);
const source = -100111;
const dest = -100222;
const env = () => ({DB:db,SOURCE_CHAT_ID:String(source),REPORT_CHAT_ID:String(dest),
  TELEGRAM_WEBHOOK_SECRET:'local-secret',TELEGRAM_BOT_TOKEN:'dummy-not-a-real-token'});
function webhook(update: object, secret = 'local-secret') {
  return worker.fetch(new Request('https://worker.local/webhook', {
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(update),
  }), env());
}
function tick(minute: number, send: (part: string) => Promise<{message_id:number}>) {
  const t = start + minute * 60_000;
  return deliverAuto(db,new Date(t),send,() => t);
}
const row = () => sql.prepare("SELECT * FROM report_runs WHERE report_type='auto'").get();
function manyOrders() {
  const insert = sql.prepare(`INSERT INTO orders
    (source_chat_id,source_message_id,order_number,description,published_at,deadline,updated_at)
    VALUES (?,?,?,?,0,'2026-11-20',0)`);
  for(let i = 1; i <= 3; i++) insert.run(String(source),i,'Z000'+i,'опис '.repeat(550));
}
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  for(const migration of ['0001_initial.sql','0002_delivery_and_reactions.sql']) {
    sql.exec(readFileSync('migrations/' + migration,'utf8'));
  }
  db = localDatabase(sql);
});
afterEach(() => {vi.unstubAllGlobals();sql.close();});
describe('automatic delivery', () => {
  it('limits new reports to the weekday delivery window in both seasons', () => {
    for (const [date, expected] of [
      ['2026-11-27T14:45Z',false],['2026-11-27T14:50Z',true],
      ['2026-11-27T15:30Z',true],['2026-11-27T15:35Z',false],
      ['2026-11-28T14:50Z',false],['2026-07-10T13:50Z',true],
    ] as const) expect(inDeliveryWindow(new Date(date))).toBe(expected);
  });
  it('resumes at the rejected part, not the first part, without rebuilding the report', async () => {
    manyOrders();
    const send = vi.fn<(part: string) => Promise<{message_id:number}>>()
      .mockResolvedValueOnce({message_id:10})
      .mockRejectedValueOnce(new TelegramRejection('sendMessage',429,360))
      .mockResolvedValueOnce({message_id:11})
      .mockResolvedValueOnce({message_id:12});
    await tick(0,send);
    expect(row()).toMatchObject({status:'retry',next_part:1,message_ids:'[10]'});
    sql.exec("UPDATE orders SET description='changed after first attempt'");
    await tick(5,send);
    expect(send).toHaveBeenCalledTimes(2);
    await tick(10,send);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[2]);
    expect(send.mock.calls[3][0]).not.toContain('changed');
    expect(row()).toMatchObject({status:'success',message_ids:'[10,11,12]'});
    await tick(15,send);
    expect(send).toHaveBeenCalledTimes(4);
  });
  it('does not retry an ambiguous delivery or a permanent rejection', async () => {
    const send = vi.fn().mockRejectedValue(new Error('lost response'));
    await tick(0,send);
    expect(row()).toMatchObject({status:'uncertain'});
    await tick(5,send);
    expect(send).toHaveBeenCalledTimes(1);
    sql.exec('DELETE FROM report_runs');
    send.mockRejectedValue(new TelegramRejection('sendMessage',403));
    await tick(0,send);
    await tick(10,send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(row()).toMatchObject({status:'failed'});
  });
  it('caps retries and does not send after the window', async () => {
    manyOrders();
    const send = vi.fn().mockResolvedValueOnce({message_id:1})
      .mockRejectedValue(new TelegramRejection('sendMessage',502));
    for(const minute of [0,5,10,15]) await tick(minute,send);
    expect(row()).toMatchObject({status:'failed',part_attempts:3,message_ids:'[1]'});
    expect(send).toHaveBeenCalledTimes(4);
    await tick(45,send);
    expect(send).toHaveBeenCalledTimes(4);
  });
  it('never starts a missed report late or retries a rejected first part after 16:50', async () => {
    const send = vi.fn().mockRejectedValue(new TelegramRejection('sendMessage',429));
    await tick(5,send);
    expect(row()).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await tick(0,send);
    await tick(5,send);
    expect(row()).toMatchObject({status:'failed',part_attempts:1,message_ids:'[]'});
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('only one overlapping scheduled invocation can send a given part', async () => {
    let begin!: () => void;
    const entered = new Promise<void>(resolve => {begin = resolve;});
    let release!: (value: {message_id:number}) => void;
    const waiting = new Promise<{message_id:number}>(resolve => {release = resolve;});
    const send = vi.fn(() => {begin();return waiting;});
    const first = tick(0,send);
    await entered;
    await tick(0,send);
    release({message_id:20});
    await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({status:'success',message_ids:'[20]'});
  });
  it('flags interrupted claims without resending', async () => {
    sql.prepare("INSERT INTO report_runs(report_type,local_date,created_at,status,parts,claim_at) VALUES ('auto','2026-11-27',0,'sending','[\"part\"]',?)")
      .run(start/1000);
    const send = vi.fn();
    await tick(10,send);
    expect(row()).toMatchObject({status:'uncertain'});
    expect(send).not.toHaveBeenCalled();
  });
});
describe('webhook integration', () => {
  it('requires the webhook secret and a valid update id', async () => {
    expect((await webhook({update_id:1},'bad-secret')).status).toBe(403);
    expect((await webhook({update_id:'1'})).status).toBe(400);
    expect(sql.prepare('SELECT * FROM processed_updates').all()).toHaveLength(0);
  });
  it('keeps reactions from distinct actors and ignores older changes for the same actor', async () => {
    const actor = (update_id: number, id: number, ...emoji: string[]) => webhook({update_id,message_reaction:{
      chat:{id:source},message_id:5,user:{id},new_reaction:emoji.map(emoji => ({type:'emoji',emoji})),
    }});
    await actor(10,21,'❤️');
    await actor(11,22,'🔥');
    const msg = {chat:{id:source},message_id:5,date:start/1000,caption:'Z0010 Original'};
    expect((await webhook({update_id:9,message:msg})).status).toBe(200);
    const order = () => sql.prepare('SELECT * FROM orders').get();
    expect(order()).toMatchObject({reaction_fire:1,reaction_heart:1});
    await actor(13,21);
    await actor(12,21,'❤️');
    expect(order()).toMatchObject({reaction_fire:1,reaction_heart:0});
    await webhook({update_id:16,edited_message:{...msg,caption:'Z0010 Newest'}});
    await webhook({update_id:15,edited_message:{...msg,caption:'Z0010 Stale'}});
    expect(order()).toMatchObject({description:'Newest',reaction_fire:1});
  });
  it('publishes a duplicated report command only once', async () => {
    const fetch = vi.fn(async (url: string) => Response.json({ok:true,
      result:url.endsWith('getChatMember') ? {status:'member'} : {message_id:1}}));
    vi.stubGlobal('fetch',fetch);
    const update = {update_id:20,message:{chat:{id:dest},date:start/1000,message_id:9,from:{id:3},text:'/report'}};
    const results = await Promise.all([webhook(update),webhook(update)]);
    expect(results.map(result => result.status)).toEqual([200,200]);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('sendMessage'))).toHaveLength(1);
    expect(sql.prepare("SELECT * FROM report_runs WHERE report_type='manual'").get())
      .toMatchObject({status:'success',message_ids:'[1]'});
  });
  it('does not let a long Unicode caption block the entire report', () => {
    const parts = reportParts([{source_chat_id:String(source),source_message_id:1,order_number:'Z0010',
      description:'🙂'.repeat(2000) + '<>&', published_at:0, deadline:'2026-11-20',reaction_fire:0,reaction_heart:0}],new Date(start));
    expect(parts.join('')).toContain('…');
    expect(parts.join('')).not.toContain('\uFFFD');
  });
});
