import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// A Supabase client stand-in that runs the project's real SQL migrations in an in-process Postgres (PGlite), for tests of
// the pipeline module. Unlike the in-memory fake it enforces the actual constraints, triggers and functions, so a test
// through the API proves the database rules and not a copy of them. It implements the slice of the query builder the
// data layer uses: select, insert, update, upsert, delete, rpc and the usual filters.
type Row = Record<string, any>;
type Result = { data: any; error: { code: string; message: string } | null; count: number | null };
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string) => { if (!IDENT.test(name)) throw new Error(`unsafe identifier ${name}`); return `"${name}"`; };

const migrationsDir = path.resolve(import.meta.dirname, "../../supabase/migrations");
const migrationSql = (name: string) => fs.readFileSync(path.join(migrationsDir, name), "utf8").replace(/^create extension if not exists pgcrypto;\s*$/m, "");

// PostgREST returns numeric as numbers, dates as plain strings and timestamps as ISO strings.
const parsers = { 1082: (value: string) => value, 1114: (value: string) => new Date(`${value}Z`).toISOString(), 1184: (value: string) => new Date(value).toISOString(), 1700: (value: string) => Number(value), 20: (value: string) => Number(value) };

export async function createPgSupabase() {
  const pg = new PGlite({ parsers });
  await pg.exec("create role anon; create role authenticated; create role service_role;");
  for (const name of fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) await pg.exec(migrationSql(name));
  const db = new PgSupabase(pg);
  await db.reset(); // remembers the seeded task template
  return db;
}

export class PgSupabase {
  readonly calls: Array<{ table: string; action: string }> = [];
  private templates: Row[] = [];
  constructor(readonly pg: PGlite) {}
  from(table: string) { return new PgQuery(this, table); }

  // Empties every table so the next test starts clean without paying for a new database. The seeded task template is put
  // back as the migration made it. Triggers are switched off for the truncate (the ledger one refuses it on purpose).
  async reset() {
    if (this.templates.length === 0) this.templates = (await this.pg.query<Row>("select position, title from public.task_templates order by position")).rows;
    const { rows } = await this.pg.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
    await this.pg.exec(`set session_replication_role = replica; truncate ${rows.map((row) => `public.${ident(row.tablename)}`).join(", ")} restart identity cascade; reset session_replication_role;`);
    for (const row of this.templates) await this.pg.query("insert into public.task_templates (position, title) values ($1, $2)", [row.position, row.title]);
    this.calls.length = 0;
  }

  async rpc(name: string, args: Row = {}): Promise<Result> {
    const keys = Object.keys(args);
    const params = keys.map((key) => (args[key] !== null && typeof args[key] === "object" && !Array.isArray(args[key]) ? JSON.stringify(args[key]) : args[key]));
    const call = `${ident(name)}(${keys.map((key, index) => `${ident(key)} => $${index + 1}`).join(", ")})`;
    this.calls.push({ table: name, action: "rpc" });
    try {
      const result = await this.pg.query<Row>(`select * from public.${call}`, params);
      const first = result.rows[0];
      // A function returning one plain value comes back as a column named after the function; a row type as an object.
      if (first && result.fields.length === 1 && result.fields[0].name === name) return { data: first[name] ?? null, error: null, count: null };
      return { data: first ?? null, error: null, count: null };
    } catch (error: any) {
      return { data: null, error: { code: error.code ?? "XX000", message: error.message }, count: null };
    }
  }
}

class PgQuery implements PromiseLike<Result> {
  private action: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row[] = [];
  private filters: Array<{ sql: (n: number) => string; values: unknown[] }> = [];
  private returning = false;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private orders: string[] = [];
  private max: number | null = null;
  private head = false;
  private wantCount = false;
  private conflict: string | undefined;

  constructor(private readonly db: PgSupabase, private readonly table: string) {}

  select(_columns = "*", options: { count?: string; head?: boolean } = {}) {
    if (this.action !== "select") this.returning = true;
    this.head = Boolean(options.head);
    this.wantCount = Boolean(options.count);
    return this;
  }
  insert(values: Row | Row[]) { this.action = "insert"; this.payload = Array.isArray(values) ? values : [values]; return this; }
  update(values: Row) { this.action = "update"; this.payload = [values]; return this; }
  upsert(values: Row | Row[], options: { onConflict?: string } = {}) { this.action = "upsert"; this.payload = Array.isArray(values) ? values : [values]; this.conflict = options.onConflict; return this; }
  delete() { this.action = "delete"; return this; }

  private compare(column: string, operator: string, value: unknown) {
    this.filters.push({ sql: (n) => `${ident(column)} ${operator} $${n}`, values: [value] });
    return this;
  }
  eq(column: string, value: unknown) { return this.compare(column, "=", value); }
  neq(column: string, value: unknown) { return this.compare(column, "<>", value); }
  gt(column: string, value: unknown) { return this.compare(column, ">", value); }
  gte(column: string, value: unknown) { return this.compare(column, ">=", value); }
  lt(column: string, value: unknown) { return this.compare(column, "<", value); }
  lte(column: string, value: unknown) { return this.compare(column, "<=", value); }
  like(column: string, pattern: string) { return this.compare(column, "like", pattern); }
  ilike(column: string, pattern: string) { return this.compare(column, "ilike", pattern); }
  in(column: string, values: unknown[]) {
    this.filters.push({ sql: (n) => `${ident(column)} = any($${n})`, values: [values] });
    return this;
  }
  is(column: string, value: null | boolean) {
    this.filters.push({ sql: () => `${ident(column)} is ${value === null ? "null" : value ? "true" : "false"}`, values: [] });
    return this;
  }
  not(column: string, operator: string, value: null) {
    if (operator !== "is" || value !== null) throw new Error("only .not(column, 'is', null) is supported");
    this.filters.push({ sql: () => `${ident(column)} is not null`, values: [] });
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) { this.orders.push(`${ident(column)} ${options.ascending === false ? "desc" : "asc"}`); return this; }
  limit(count: number) { this.max = count; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  private where(start: number) {
    const values: unknown[] = [];
    const parts = this.filters.map((filter) => { const sql = filter.sql(start + values.length); values.push(...filter.values); return sql; });
    return { sql: parts.length ? ` where ${parts.join(" and ")}` : "", values };
  }
  private bind(value: unknown) { return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) ? JSON.stringify(value) : value; }

  private async run(): Promise<Result> {
    this.db.calls.push({ table: this.table, action: this.action });
    const table = `public.${ident(this.table)}`;
    let text: string;
    let params: unknown[] = [];
    if (this.action === "select") {
      const clause = this.where(1);
      params = clause.values;
      text = this.head ? `select count(*)::int as n from ${table}${clause.sql}` : `select * from ${table}${clause.sql}${this.orders.length ? ` order by ${this.orders.join(", ")}` : ""}${this.max !== null ? ` limit ${Number(this.max)}` : ""}`;
    } else if (this.action === "insert" || this.action === "upsert") {
      const columns = [...new Set(this.payload.flatMap((row) => Object.keys(row)))];
      const tuples = this.payload.map((row) => `(${columns.map((column) => { params.push(this.bind(row[column] ?? null)); return `$${params.length}`; }).join(", ")})`);
      text = `insert into ${table} (${columns.map(ident).join(", ")}) values ${tuples.join(", ")}`;
      if (this.action === "upsert") {
        const key = this.conflict ?? "id";
        text += ` on conflict (${ident(key)}) do update set ${columns.filter((column) => column !== key).map((column) => `${ident(column)} = excluded.${ident(column)}`).join(", ")}`;
      }
      text += " returning *";
    } else if (this.action === "update") {
      const values = this.payload[0];
      const assignments = Object.keys(values).map((column) => { params.push(this.bind(values[column] ?? null)); return `${ident(column)} = $${params.length}`; });
      const clause = this.where(params.length + 1);
      params.push(...clause.values);
      text = `update ${table} set ${assignments.join(", ")}${clause.sql} returning *`;
    } else {
      const clause = this.where(1);
      params = clause.values;
      text = `delete from ${table}${clause.sql} returning *`;
    }
    try {
      const result = await this.db.pg.query<Row>(text, params);
      if (this.action === "select" && this.head) return { data: null, error: null, count: result.rows[0].n };
      if (this.action !== "select" && !this.returning && this.mode === "many") return { data: null, error: null, count: null };
      let rows = result.rows;
      if (this.action !== "select" && this.orders.length === 0) rows = result.rows;
      const count = this.wantCount ? rows.length : null;
      if (this.mode === "many") return { data: rows, error: null, count };
      if (rows.length > 1 || (this.mode === "single" && rows.length === 0)) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, count: null };
      return { data: rows[0] ?? null, error: null, count };
    } catch (error: any) {
      return { data: null, error: { code: error.code ?? "XX000", message: error.message }, count: null };
    }
  }
}
