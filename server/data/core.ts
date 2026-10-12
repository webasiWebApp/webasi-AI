import { ENV } from "../_core/env";
import type { ApprovedProjectSnapshot } from "../conversations/project";
import type { Project } from "./projects";
import type { Settings } from "./settings";

// Supabase is the only database. Without its URL and service key (the test suite, or a run with no credentials) reads
// answer with empty defaults and writes report that nothing was stored, so the rest of the server still runs.
export const hasDatabase = () => Boolean(ENV.supabaseUrl && ENV.supabaseServiceRoleKey);

export function createTtlCache<T>(ttlMs: number) {
  let value: T | undefined;
  let expiresAt = 0;
  return {
    get(): T | undefined { return Date.now() < expiresAt ? value : undefined; },
    set(v: T) { value = v; expiresAt = Date.now() + ttlMs; },
    invalidate() { expiresAt = 0; },
  };
}

// Settings, the active project and its compiled facts are read on every incoming message but change rarely.
// Writes in this process invalidate them at once; the short TTL bounds how long a change made from another
// server instance (for example the automation switch flipped from a separately hosted dashboard) takes to apply.
export const settingsCache = createTtlCache<Settings>(15_000);
export const activeProjectCache = createTtlCache<Project | null>(30_000);
export const compiledSnapshotCache = new Map<string, { value: ApprovedProjectSnapshot; expiresAt: number }>();
export function invalidateProjectCaches() { activeProjectCache.invalidate(); compiledSnapshotCache.clear(); }

// A client's message is stored as the question of an FAQ. Kept to one line, it cannot add "Q:"/"A:" lines of its own
// that would be read as further approved answers.
export const asQuestionLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
