import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { buildSnapshot } from "../src/report";
import { testEnv, now } from "./helpers";
test("snapshot reports aged pending, holds, budgets and uncertainty", async () => {
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,state,due_at,created_at) VALUES('p','owner','a@example.com','pending',0,0),('u','owner','a@example.com','review_required',0,0)",
  ).run();
  const s = await buildSnapshot(testEnv(), now);
  expect(s.pending).toBe(1);
  expect(s.uncertain).toBe(1);
  expect(s.warnings.join(" ")).toMatch(/48 hours/);
});
