import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = mkdtempSync(join(tmpdir(), "mission-restore-"));
function run(args) {
  const r = spawnSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (r.status !== 0) throw Error(r.stderr + "\n" + r.stdout);
  return r.stdout;
}
try {
  const source = join(root, "source");
  const restored = join(root, "restored");
  const snapshot = join(root, "snapshot.sql");
  const seed = join(root, "seed.sql");
  function config(dir) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "wrangler.json");
    writeFileSync(
      path,
      JSON.stringify({
        name: "restore-fixture",
        compatibility_date: "2026-10-19",
        d1_databases: [
          {
            binding: "DB",
            database_name: "fixture",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: resolve("migrations"),
          },
        ],
      }),
    );
    return path;
  }
  const sourceConfig = config(source);
  const restoreConfig = config(restored);
  run(["d1", "migrations", "apply", "DB", "--local", "--config", sourceConfig]);
  writeFileSync(
    seed,
    `INSERT INTO subscribers(id,email,status,generation,version,created_at,updated_at,source,consent_version) VALUES('restore-member','fixture@example.com','active',7,3,0,0,'test','v1');
INSERT INTO suppressions VALUES('fixture@example.com','complaint',0);
INSERT INTO outbox(id,kind,recipient,state,due_at,created_at) VALUES('restore-pending','owner','fixture@example.com','pending',0,0);
INSERT INTO outbox(id,kind,recipient,state,due_at,created_at) VALUES('restore-accepted','owner','other@example.com','pending',0,0);
INSERT INTO send_attempts(id,outbox_id,kind,reserved_at,run_id) VALUES('restore-attempt','restore-accepted','owner',0,'fixture-run');
UPDATE outbox SET state='accepted',provider_id='fixture-ses' WHERE id='restore-accepted';
INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,text_key,received_at,run_id) VALUES('restore-body','broadcast','raw/fixture.eml','hash','fixture@example.com','fingerprint','Week','','text/${"a".repeat(64)}.txt',0,'fixture-run');
INSERT INTO broadcasts(id,inbound_id,subject,text,text_key,album_url,created_at) SELECT id,id,subject,text,text_key,'',0 FROM inbound_messages WHERE id='restore-body';
UPDATE broadcasts SET completion_reported=0 WHERE id='restore-body';
INSERT INTO outbox(id,kind,recipient,subscriber_id,generation,subject,text,state,due_at,created_at,unique_key,is_welcome) VALUES('restore-welcome','newsletter','fixture@example.com','restore-member',7,'Welcome','Welcome fixture','pending',0,0,'restore-welcome',1);
UPDATE inbound_messages SET archive_key='pages/v1/${"b".repeat(64)}.html' WHERE id='restore-body';
INSERT INTO receipt_jobs(id,raw_key,destination,envelope_from,raw_size,state,attempts,holder,lease_until,created_at) VALUES('restore-receipt','receipts/fixture.eml','update@example.com','fixture@example.com',123,'processing',2,'old-worker',42,0);`,
  );
  run([
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    sourceConfig,
    "--file",
    seed,
  ]);
  run([
    "d1",
    "export",
    "DB",
    "--local",
    "--config",
    sourceConfig,
    "--output",
    snapshot,
  ]);
  run([
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    restoreConfig,
    "--file",
    snapshot,
  ]);
  const output = run([
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    restoreConfig,
    "--json",
    "--command",
    "SELECT (SELECT generation FROM subscribers WHERE id='restore-member') generation,(SELECT reason FROM suppressions WHERE email='fixture@example.com') suppression,(SELECT state FROM outbox WHERE id='restore-pending') pending,(SELECT state FROM outbox WHERE id='restore-accepted') accepted,(SELECT provider_id FROM send_attempts WHERE id='restore-attempt') provider_id,(SELECT text_key FROM inbound_messages WHERE id='restore-body') inbound_body,(SELECT text_key FROM broadcasts WHERE id='restore-body') broadcast_body,(SELECT raw_key FROM receipt_jobs WHERE id='restore-receipt') receipt_raw,(SELECT attempts FROM receipt_jobs WHERE id='restore-receipt') receipt_attempts,(SELECT lease_until FROM receipt_jobs WHERE id='restore-receipt') receipt_lease,(SELECT is_welcome FROM outbox WHERE id='restore-welcome') welcome_flag,(SELECT completion_reported FROM broadcasts WHERE id='restore-body') completion_flag;",
  ]);
  const result = JSON.parse(output)[0].results[0];
  const pageOutput = run([
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    restoreConfig,
    "--json",
    "--command",
    "SELECT archive_key FROM inbound_messages WHERE id='restore-body'",
  ]);
  if (
    JSON.parse(pageOutput)[0].results[0].archive_key !==
    `pages/v1/${"b".repeat(64)}.html`
  )
    throw Error("Restored private archive page reference differs");
  if (
    result.generation !== 7 ||
    result.suppression !== "complaint" ||
    result.pending !== "pending" ||
    result.accepted !== "accepted" ||
    result.provider_id !== "fixture-ses" ||
    result.inbound_body !== `text/${"a".repeat(64)}.txt` ||
    result.broadcast_body !== result.inbound_body ||
    result.receipt_raw !== "receipts/fixture.eml" ||
    result.receipt_attempts !== 2 ||
    result.receipt_lease !== 42 ||
    result.welcome_flag !== 1 ||
    result.completion_flag !== 0
  )
    throw Error(
      "Restored database differs from fixture: " + JSON.stringify(result),
    );
  console.log(
    "PASS: isolated full SQL export/restore preserves generations, suppressions, pending work, accepted attempt correlation, private body/page references receipt job recovery state and confirmation flags.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
