// In-memory stand-in for the Supabase client, for tests only. It implements the slice of the query builder this
// project uses, with the unique constraints from supabase/migrations, so database code runs against an isolated
// store instead of a live project.
type Row = Record<string, any>;
type Action = "select" | "insert" | "update" | "upsert" | "delete";
type FakeError = { code: string; message: string };
type Result = { data: any; error: FakeError | null; count: number | null };

const UNIQUE: Record<string, string[]> = {
  settings: ["singleton_key"], projects: ["project_key"], conversations: ["client_id", "wa_id"], messages: ["message_id"],
  usage_counters: ["period_key"], training_sessions: ["project_key"], orders: ["order_key"], baileys_auth_state: ["state_key"],
};
const PRIMARY_KEY: Record<string, string> = { baileys_auth_state: "state_key" };
const DEFAULTS: Record<string, () => Row> = {
  settings: () => ({ singleton_key: "owner", business_name: "WEBASI", bank_details: "", notification_email: null, whatsapp_monthly_cap: 900, gemini_daily_cap: 500, webasi_enabled: false, shadow_mode: false, ai_provider: null, followups_enabled: true, weekly_summary_enabled: true }),
  projects: () => ({ status: "draft", readiness: 0, version: 1, snapshot: {} }),
  conversations: () => ({ state: "new", is_paused: false, missing_fields: [], extracted_fields: {}, recent_messages: [], handed_over: false, client_notes: "" }),
  training_sessions: () => ({ checklist: [], answers: {}, summary: "", approved: false }),
  insights: () => ({ status: "suggested" }),
  orders: () => ({ state: "awaiting_deposit", notes: "" }),
  knowledge_gaps: () => ({ reason: "", status: "pending", answer: null }),
  usage_counters: () => ({ outbound_whatsapp: 0, gemini_requests: 0 }),
};

export class FakeSupabase {
  readonly tables = new Map<string, Row[]>();
  // Every query that ran, so a test can assert how often the database was touched.
  readonly calls: Array<{ table: string; action: Action }> = [];
  private failures: Array<{ table: string; action: Action; error: FakeError; skip: number }> = [];
  private nextId = 1;
  private clock = Date.parse("2026-10-01T00:00:00.000Z");

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  seed(table: string, ...rows: Row[]) {
    for (const row of rows) this.rows(table).push(this.withDefaults(table, row));
    return this;
  }

  // A matching query fails with this error instead of running: the next one, or the one after `skip` successful ones.
  failNext(table: string, action: Action, { skip = 0, error = { code: "XX000", message: `${table} ${action} failed` } }: { skip?: number; error?: FakeError } = {}) {
    this.failures.push({ table, action, error, skip });
    return this;
  }

  takeFailure(table: string, action: Action): FakeError | null {
    const index = this.failures.findIndex((failure) => failure.table === table && failure.action === action);
    if (index < 0) return null;
    if (this.failures[index].skip > 0) { this.failures[index].skip -= 1; return null; }
    return this.failures.splice(index, 1)[0].error;
  }

  // Timestamps move forward by a second per write so ordering by them is deterministic.
  now() { this.clock += 1000; return new Date(this.clock).toISOString(); }

  withDefaults(table: string, row: Row): Row {
    const stamp = this.now();
    return { id: `row-${this.nextId++}`, created_at: stamp, updated_at: stamp, ...(DEFAULTS[table]?.() ?? {}), ...structuredClone(row) };
  }

  // Mirrors the constraints the migrations create; returns the violated rule, if any.
  violation(table: string, rows: Row[]): string | null {
    for (const column of UNIQUE[table] ?? []) {
      const seen = new Set<unknown>();
      for (const row of rows) { if (seen.has(row[column])) return `duplicate key value violates unique constraint "${table}_${column}_key"`; seen.add(row[column]); }
    }
    if (table === "projects" && rows.filter((row) => row.status === "active").length > 1) return 'duplicate key value violates unique constraint "projects_one_active_idx"';
    return null;
  }

  from(table: string) { return new FakeQuery(this, table); }

  // No database functions exist unless a test registers one, like a project whose RPC migration was not applied.
  rpcHandlers: Record<string, (args: Row) => void> = {};
  async rpc(name: string, args: Row): Promise<Result> {
    const handler = this.rpcHandlers[name];
    if (!handler) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` }, count: null };
    handler(args);
    return { data: null, error: null, count: null };
  }
}

class FakeQuery implements PromiseLike<Result> {
  private action: Action = "select";
  private payload: Row[] = [];
  private filters: Array<(row: Row) => boolean> = [];
  private returning = false;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private ordering: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private head = false;
  private conflictColumn: string | undefined;

  constructor(private readonly db: FakeSupabase, private readonly table: string) {}

  select(_columns = "*", options: { count?: string; head?: boolean } = {}) {
    if (this.action !== "select") this.returning = true;
    this.head = Boolean(options.head);
    return this;
  }
  insert(values: Row | Row[]) { this.action = "insert"; this.payload = Array.isArray(values) ? values : [values]; return this; }
  update(values: Row) { this.action = "update"; this.payload = [values]; return this; }
  upsert(values: Row | Row[], options: { onConflict?: string } = {}) { this.action = "upsert"; this.payload = Array.isArray(values) ? values : [values]; this.conflictColumn = options.onConflict; return this; }
  delete(_options: { count?: string } = {}) { this.action = "delete"; return this; }

  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this; }
  gte(column: string, value: any) { this.filters.push((row) => row[column] >= value); return this; }
  lt(column: string, value: any) { this.filters.push((row) => row[column] < value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  like(column: string, pattern: string) {
    const expression = new RegExp(`^${pattern.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    this.filters.push((row) => expression.test(String(row[column] ?? "")));
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) { this.ordering = { column, ascending: options.ascending !== false }; return this; }
  limit(count: number) { this.max = count; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(onFulfilled, onRejected);
  }

  private run(): Result {
    this.db.calls.push({ table: this.table, action: this.action });
    const failure = this.db.takeFailure(this.table, this.action);
    if (failure) return { data: null, error: failure, count: null };

    const stored = this.db.rows(this.table);
    const matches = (row: Row) => this.filters.every((filter) => filter(row));
    let affected: Row[] = [];

    if (this.action === "select") affected = stored.filter(matches);
    else if (this.action === "delete") {
      affected = stored.filter(matches);
      this.db.tables.set(this.table, stored.filter((row) => !matches(row)));
    } else {
      // Writes are applied to a copy and kept only if no constraint is violated, as a database would.
      const next = stored.map((row) => ({ ...row }));
      if (this.action === "insert") affected = this.payload.map((values) => this.db.withDefaults(this.table, values));
      if (this.action === "insert") next.push(...affected);
      if (this.action === "update") {
        affected = next.filter(matches);
        for (const row of affected) Object.assign(row, structuredClone(this.payload[0]));
      }
      if (this.action === "upsert") {
        const key = this.conflictColumn ?? PRIMARY_KEY[this.table] ?? "id";
        for (const values of this.payload) {
          const existing = next.find((row) => row[key] === values[key]);
          if (existing) { Object.assign(existing, structuredClone(values)); affected.push(existing); }
          else { const created = this.db.withDefaults(this.table, values); next.push(created); affected.push(created); }
        }
      }
      const violated = this.db.violation(this.table, next);
      if (violated) return { data: null, error: { code: "23505", message: violated }, count: null };
      this.db.tables.set(this.table, next);
      if (!this.returning) return { data: null, error: null, count: null };
    }

    const count = affected.length;
    if (this.head) return { data: null, error: null, count };
    if (this.ordering) {
      const { column, ascending } = this.ordering;
      affected = [...affected].sort((a, b) => (a[column] === b[column] ? 0 : a[column] > b[column] ? 1 : -1) * (ascending ? 1 : -1));
    }
    if (this.max !== null) affected = affected.slice(0, this.max);
    const data = structuredClone(affected);
    if (this.mode === "many") return { data, error: null, count };
    // supabase-js reports more than one row, or none for single(), as PGRST116 with no data.
    if (data.length > 1 || (this.mode === "single" && data.length === 0)) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, count: null };
    return { data: data[0] ?? null, error: null, count };
  }
}
