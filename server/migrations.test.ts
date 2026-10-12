import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// The SQL in supabase/migrations, applied in order to a real Postgres running inside this process (PGlite). Nothing
// here touches the hosted database; it proves the files apply cleanly and that the database functions do what the
// server expects of them.
const migrationsDir = path.resolve(import.meta.dirname, "../supabase/migrations");
const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
// gen_random_uuid() is built into Postgres 13+, so the extension line is only needed on older servers.
const sql = (name: string) => fs.readFileSync(path.join(migrationsDir, name), "utf8").replace(/^create extension if not exists pgcrypto;\s*$/m, "");

let db: PGlite;
const rows = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await db.query<T>(query, params)).rows;

beforeAll(async () => {
  db = new PGlite();
  // The roles Supabase provides and the migrations name in their policies and grants.
  await db.exec("create role anon; create role authenticated; create role service_role;");
  for (const name of files) await db.exec(sql(name));
}, 60_000);

describe("database migrations", () => {
  it("apply in order to an empty database", async () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    const tables = (await rows<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by tablename")).map((row) => row.tablename);
    expect(tables).toEqual(["baileys_auth_state", "conversations", "event_log", "insights", "knowledge_gaps", "messages", "orders", "projects", "settings", "training_sessions", "usage_counters"]);
  });

  it("can be re-run from 002 onwards without error, as the README says", async () => {
    for (const name of files.filter((file) => !file.startsWith("001_"))) await db.exec(sql(name));
  });

  it("leave every table closed to the browser key: row-level security on, no policies", async () => {
    const open = await rows("select tablename from pg_tables where schemaname = 'public' and not rowsecurity");
    const policies = await rows("select tablename, policyname from pg_policies where schemaname = 'public'");
    expect(open).toEqual([]);
    expect(policies).toEqual([]);
  });

  it("allow only one active project", async () => {
    await db.exec("delete from projects; insert into projects (project_key, name, status) values ('a', 'A', 'active'), ('b', 'B', 'approved');");
    await expect(db.exec("update projects set status = 'active' where project_key = 'b'")).rejects.toThrow(/projects_one_active_idx/);
  });

  it("create the indexes the repeated queries rely on", async () => {
    const names = (await rows<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public'")).map((row) => row.indexname);
    expect(names).toEqual(expect.arrayContaining(["conversations_updated_at_idx", "event_log_created_at_idx", "event_log_type_created_idx", "messages_created_at_idx", "orders_updated_at_idx", "orders_wa_state_idx", "insights_category_status_idx", "knowledge_gaps_status_created_idx"]));
  });
});

describe("activate_project", () => {
  const statuses = async () => Object.fromEntries((await rows<{ project_key: string; status: string }>("select project_key, status from projects")).map((row) => [row.project_key, row.status]));

  it("switches the active project in one step", async () => {
    await db.exec("delete from projects; insert into projects (project_key, name, status) values ('a', 'A', 'active'), ('b', 'B', 'approved'), ('c', 'C', 'training');");
    await db.query("select activate_project($1)", ["b"]);
    expect(await statuses()).toEqual({ a: "approved", b: "active", c: "training" });
    await db.query("select activate_project($1)", ["b"]);
    expect(await statuses()).toEqual({ a: "approved", b: "active", c: "training" });
  });

  it("changes nothing when the project does not exist", async () => {
    await db.exec("delete from projects; insert into projects (project_key, name, status) values ('a', 'A', 'active');");
    await expect(db.query("select activate_project($1)", ["missing"])).rejects.toThrow(/does not exist/);
    expect(await statuses()).toEqual({ a: "active" });
  });
});

describe("append_conversation_message", () => {
  const transcript = async () => (await rows<{ recent_messages: Array<{ role: string; text: string }> }>("select recent_messages from conversations where client_id = 'c1'"))[0].recent_messages;

  it("adds messages in order and keeps the newest ones", async () => {
    await db.exec("delete from conversations;");
    await db.query("insert into conversations (client_id, wa_id, recent_messages) values ('c1', '94770001111', $1::jsonb)", [JSON.stringify(Array.from({ length: 19 }, (_, index) => ({ role: "client", text: `message ${index}` })))]);
    await db.query("select append_conversation_message($1, $2::jsonb, 20)", ["c1", JSON.stringify({ role: "client", text: "question" })]);
    await db.query("select append_conversation_message($1, $2::jsonb, 20)", ["c1", JSON.stringify({ role: "assistant", text: "answer", at: "2026-10-11T10:00:00.000Z" })]);
    const stored = await transcript();
    expect(stored).toHaveLength(20);
    expect(stored[0]).toEqual({ role: "client", text: "message 1" });
    expect(stored.slice(-2)).toEqual([{ role: "client", text: "question" }, { role: "assistant", text: "answer", at: "2026-10-11T10:00:00.000Z" }]);
  });

  it("starts a transcript from empty and ignores a chat that does not exist", async () => {
    await db.exec("delete from conversations; insert into conversations (client_id, wa_id) values ('c1', '94770001111');");
    await db.query("select append_conversation_message($1, $2::jsonb)", ["c1", JSON.stringify({ role: "owner", text: "Hello" })]);
    await db.query("select append_conversation_message($1, $2::jsonb)", ["nobody", JSON.stringify({ role: "owner", text: "Hello" })]);
    expect(await transcript()).toEqual([{ role: "owner", text: "Hello" }]);
    expect(await rows("select client_id from conversations")).toHaveLength(1);
  });
});

describe("increment_usage_counter", () => {
  it("counts each kind of usage under its own period", async () => {
    await db.exec("delete from usage_counters;");
    for (const [period, column] of [["2026-10", "outbound_whatsapp"], ["2026-10", "outbound_whatsapp"], ["2026-10-11", "gemini_requests"]]) await db.query("select increment_usage_counter($1, $2)", [period, column]);
    expect(await rows("select period_key, outbound_whatsapp, gemini_requests from usage_counters order by period_key")).toEqual([{ period_key: "2026-10", outbound_whatsapp: 2, gemini_requests: 0 }, { period_key: "2026-10-11", outbound_whatsapp: 0, gemini_requests: 1 }]);
  });
});
