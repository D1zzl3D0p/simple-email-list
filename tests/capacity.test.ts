import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { configure, testEnv, now } from "./helpers";
import { runScheduled } from "../src/delivery";
import { prepareNextMessage } from "../src/mail";
import { snapshotStatement } from "../src/report";
import { queueBroadcastSummary } from "../src/confirmations";

function meter(db: D1Database) {
  const measurements: { sql: string; read: number; written: number }[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sqls = new WeakMap<D1PreparedStatement, string>();
  const record = (sql: string, result: D1Result) => {
    measurements.push({
      sql,
      read: result.meta.rows_read,
      written: result.meta.rows_written,
    });
    return result;
  };
  function wrap(
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "all" || key === "run")
          return async () => record(sql, await target[key]());
        if (key === "first")
          return async (column?: string) => {
            const result = await target.all<Record<string, unknown>>();
            record(sql, result);
            const row = result.results[0] ?? null;
            return column ? (row?.[column] ?? null) : row;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    sqls.set(proxy, sql);
    return proxy;
  }
  return {
    measurements,
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => wrap(target.prepare(sql), sql);
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(
              statements.map((s) => originals.get(s) ?? s),
            );
            return results.map((r, i) =>
              record(sqls.get(statements[i]) ?? "batch", r),
            );
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

test.each([
  { count: 501, quota: 10000 },
  { count: 1000, quota: 10000 },
  { count: 1000, quota: 200 },
])(
  "weekly capacity: $count subscribers, SES quota $quota, two years of history",
  async ({ count, quota }) => {
    await configure();
    await env.DB.prepare("UPDATE settings SET paused=0").run();
    await env.DB.prepare(
      "INSERT INTO subscribers(id,email,status,created_at,updated_at,source,consent_version) SELECT printf('00000000-0000-4000-8000-%012d',value),'reader'||value||'@example.com','active',0,0,'capacity','v1' FROM json_each(?)",
    )
      .bind(JSON.stringify(Array.from({ length: count }, (_, i) => i)))
      .run();
    const start = now.getTime();
    await env.DB.prepare(
      "INSERT INTO broadcasts(id,subject,text,album_url,created_at) SELECT 'history-'||value,'Weekly mission update','','https://photos.google.com/fixture',?-(value+1)*604800000 FROM json_each(?)",
    )
      .bind(start, JSON.stringify(Array.from({ length: 104 }, (_, i) => i)))
      .run();
    await env.DB.prepare(
      "INSERT INTO outbox(id,kind,recipient,broadcast_id,subscriber_id,generation,state,due_at,created_at,attempt_count,attempt_id,provider_id) SELECT b.id||':'||s.id,'newsletter',s.email,b.id,s.id,1,'delivered',b.created_at,b.created_at,1,'attempt:'||b.id||':'||s.id,'ses:'||b.id||':'||s.id FROM broadcasts b CROSS JOIN subscribers s",
    ).run();
    await env.DB.prepare(
      "INSERT INTO send_attempts(id,outbox_id,kind,reserved_at,outcome,provider_id,run_id) SELECT attempt_id,id,kind,created_at,'delivered',provider_id,'historical-run' FROM outbox",
    ).run();
    await env.DB.prepare(
      "UPDATE outbox SET state='delivered' WHERE state='sending'",
    ).run();
    await env.DB.prepare(
      "INSERT INTO provider_events(id,type,provider_id,attempt_id,received_at) SELECT 'event:'||id,'Delivery',provider_id,attempt_id,created_at FROM outbox",
    ).run();
    await env.DB.prepare(
      "WITH RECURSIVE ticks(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ticks WHERE n<69888) INSERT INTO processing_runs(id,recipient,source,started_at,finished_at) SELECT printf('tick:00000000-0000-4000-8000-%012d',n),'missionary@example.com','scheduled',?-n*900000,?-n*900000+10 FROM ticks",
    )
      .bind(start, start)
      .run();
    await env.DB.prepare(
      "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,run_id) VALUES('current','broadcast','fixture','current','missionary@example.com','current','Current update','Hello',?,'capacity')",
    )
      .bind(start)
      .run();
    const measured = meter(env.DB);
    const e = testEnv({
      DB: measured.db,
      SENDING_ENABLED: "true",
      SES_DAILY_QUOTA: String(quota),
      SES_RATE: "1000",
    });
    await prepareNextMessage(e, now);
    const fanout = measured.measurements.splice(0);
    let sent = 0,
      ticks = 0;
    let ms = start;
    const tickUsage: {
      read: number;
      written: number;
      sent: number;
      queries: number;
    }[] = [];
    while (sent < count + 1 && ticks < 672) {
      ms = start + ticks * 900000;
      const before = sent;
      await runScheduled(e, new Date(ms), {
        clock: () => new Date(ms),
        sleep: async (n) => {
          ms += n;
        },
        send: async () => {
          sent++;
          return { kind: "accepted", messageId: `ses:${sent}` };
        },
      });
      const tick = measured.measurements.splice(0);
      tickUsage.push({
        read: tick.reduce((n, r) => n + r.read, 0),
        written: tick.reduce((n, r) => n + r.written, 0),
        sent: sent - before,
        queries: tick.length,
      });
      ticks++;
    }
    expect(await queueBroadcastSummary(e, new Date(ms))).toBe(
      "broadcast-summary:current",
    );
    const completionUsage = measured.measurements.splice(0);
    ms = start + ticks * 900000;
    const beforeSummary = sent;
    await runScheduled(e, new Date(ms), {
      clock: () => new Date(ms),
      sleep: async (n) => {
        ms += n;
      },
      send: async () => {
        sent++;
        return { kind: "accepted", messageId: `ses:${sent}` };
      },
    });
    const completionDelivery = measured.measurements.splice(0);
    tickUsage.push({
      read: [...completionUsage, ...completionDelivery].reduce(
        (n, r) => n + r.read,
        0,
      ),
      written: [...completionUsage, ...completionDelivery].reduce(
        (n, r) => n + r.written,
        0,
      ),
      sent: sent - beforeSummary,
      queries: Math.max(completionUsage.length, completionDelivery.length),
    });
    ticks++;
    await snapshotStatement(e, new Date(ms)).all();
    const report = measured.measurements.splice(0);
    const meta = (await env.DB.prepare("SELECT count(*) FROM outbox").all())
      .meta;
    // The values alone are a lower bound on SQL export size (before INSERT/DDL syntax).
    let exportValueBytes = 0;
    for (const { name } of (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      ).all<{ name: string }>()
    ).results) {
      const identifier = '"' + name.replaceAll('"', '""') + '"';
      const columns = (
        await env.DB.prepare(`PRAGMA table_info(${identifier})`).all<{
          name: string;
        }>()
      ).results;
      const lengths = columns
        .map(
          (c) =>
            'length(CAST(quote("' +
            c.name.replaceAll('"', '""') +
            '") AS BLOB))',
        )
        .join("+");
      exportValueBytes += Number(
        await env.DB.prepare(
          `SELECT coalesce(sum(${lengths}),0) bytes FROM ${identifier}`,
        ).first("bytes"),
      );
    }
    const peakDayReads =
      Math.max(
        ...tickUsage.map((_, i) =>
          tickUsage.slice(i, i + 96).reduce((n, t) => n + t.read, 0),
        ),
      ) + fanout.reduce((n, r) => n + r.read, 0);
    const peakDayWrites =
      Math.max(
        ...tickUsage.map((_, i) =>
          tickUsage.slice(i, i + 96).reduce((n, t) => n + t.written, 0),
        ),
      ) + fanout.reduce((n, r) => n + r.written, 0);
    console.log(
      "CAPACITY_RESULT",
      JSON.stringify({
        subscribers: count,
        quota,
        historyWeeks: 104,
        historyTicks: 69888,
        fanoutReads: fanout.reduce((n, r) => n + r.read, 0),
        fanoutWrites: fanout.reduce((n, r) => n + r.written, 0),
        sent,
        ticks,
        hours: ticks / 4,
        firstTick: tickUsage[0],
        maxTickReads: Math.max(...tickUsage.map((t) => t.read)),
        maxTickWrites: Math.max(...tickUsage.map((t) => t.written)),
        peakDayReads,
        peakDayWrites,
        reportReads: report.reduce((n, r) => n + r.read, 0),
        databaseBytes: meta.size_after,
        exportValueBytes,
      }),
    );
    expect(sent).toBe(count + 2);
    expect(
      await env.DB.prepare(
        "SELECT count(*) count FROM outbox WHERE broadcast_id='current' AND state='accepted' AND attempt_count=1",
      ).first("count"),
    ).toBe(count);
    expect(ticks).toBeLessThan(672);
    expect(Math.max(...tickUsage.map((t) => t.queries))).toBeLessThan(40);
    // Reserve the rest of the daily read allowance for callbacks and ten status views.
    expect(
      peakDayReads + report.reduce((n, r) => n + r.read, 0) * 10,
    ).toBeLessThan(5_000_000);
    expect(peakDayWrites).toBeLessThan(100_000);
  },
  120000,
);
