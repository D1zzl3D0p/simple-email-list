import { env } from "cloudflare:test";
import { expect, test } from "vitest";
test("schema_invariants", async () => {
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('s','a@example.com','active',1,0,0,'test','v1')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO suppressions(email,reason,created_at) VALUES('a@example.com','complaint',0)",
  ).run();
  await env.DB.prepare(
    "UPDATE subscribers SET status='unsubscribed',generation=2 WHERE id='s'",
  ).run();
  expect(
    await env.DB.prepare("SELECT reason FROM suppressions").first("reason"),
  ).toBe("complaint");
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at,unique_key) VALUES('o','owner','a@example.com','s','t','pending',0,0,'weekly:2026-43')",
  ).run();
  await expect(
    env.DB.prepare(
      "INSERT INTO outbox(id,kind,recipient,state,due_at,created_at,unique_key) VALUES('p','owner','a@example.com','pending',0,0,'weekly:2026-43')",
    ).run(),
  ).rejects.toThrow();
  await env.DB.prepare(
    "INSERT INTO broadcasts(id,subject,text,album_url,created_at) VALUES('b','s','t','https://example.com',0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,broadcast_id,subscriber_id,generation,state,due_at,created_at) VALUES('n','newsletter','a@example.com','b','s',2,'pending',0,0)",
  ).run();
  await expect(
    env.DB.prepare(
      "INSERT INTO outbox(id,kind,recipient,broadcast_id,subscriber_id,generation,state,due_at,created_at) VALUES('n2','newsletter','a@example.com','b','s',2,'pending',0,0)",
    ).run(),
  ).rejects.toThrow();
});
test("atomic_batch_rollback", async () => {
  await expect(
    env.DB.batch([
      env.DB.prepare("UPDATE settings SET paused=0 WHERE id=1"),
      env.DB.prepare("INSERT INTO settings(id) VALUES(1)"),
    ]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT paused FROM settings").first("paused"),
  ).toBe(1);
});
