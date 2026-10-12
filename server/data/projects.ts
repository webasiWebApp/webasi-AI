import { getSupabaseServer } from "../_core/supabase";
import { canActivateProject } from "../../shared/webasi";
import { activeProjectCache, hasDatabase, invalidateProjectCaches, settingsCache } from "./core";

export const mapProject = (row: any) => row ? { ...row, projectKey: row.project_key, readiness: row.readiness ?? 0, snapshot: typeof row.snapshot === "string" ? row.snapshot : JSON.stringify(row.snapshot ?? {}), createdAt: row.created_at, updatedAt: row.updated_at } : null;
export type Project = NonNullable<ReturnType<typeof mapProject>>;

export async function listProjects() {
  if (!hasDatabase()) return [];
  const { data, error } = await getSupabaseServer().from("projects").select("*").order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapProject);
}

export async function getProjectByKey(projectKey: string) {
  if (!hasDatabase()) return null;
  const { data, error } = await getSupabaseServer().from("projects").select("*").eq("project_key", projectKey).maybeSingle();
  if (error) throw error;
  return mapProject(data);
}

async function loadActiveProject() {
  if (!hasDatabase()) return null;
  const supabase = getSupabaseServer();
  const { data, error } = await supabase.from("projects").select("*").eq("status", "active").limit(1).maybeSingle();
  if (error) throw error;
  if (data) return mapProject(data);
  const fallback = await supabase.from("projects").select("*").eq("status", "approved").limit(1).maybeSingle();
  if (fallback.error) throw fallback.error;
  return mapProject(fallback.data);
}

export async function getActiveProject() {
  const cached = activeProjectCache.get();
  if (cached !== undefined) return cached;
  const result = await loadActiveProject();
  activeProjectCache.set(result);
  return result;
}

export async function createProject(input: { projectKey: string; name: string; snapshot: string }) {
  invalidateProjectCaches();
  if (!hasDatabase()) return null;
  const { data, error } = await getSupabaseServer().from("projects").insert({ project_key: input.projectKey, name: input.name, status: "training", readiness: 0, version: 1, snapshot: JSON.parse(input.snapshot) }).select("*").single();
  if (error) throw error;
  return mapProject(data);
}

export async function approveProject(projectKey: string) {
  invalidateProjectCaches();
  // The dashboard only offers this once every training answer is in; the server holds the same line.
  const project = await getProjectByKey(projectKey);
  if (!project || project.readiness < 100) return false;
  // An active project is already past approval. Marking it "approved" again would take it out of service.
  if (project.status === "active") return true;
  const { error } = await getSupabaseServer().from("projects").update({ status: "approved", readiness: 100, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
  if (error) throw error;
  return true;
}

// Set once the database says it has no activate_project function (migration 20261011 not applied), so later switches
// go straight to the two-step path below instead of paying for a failed call each time.
let activateFunctionMissing = false;

export async function activateProject(projectKey: string) {
  invalidateProjectCaches();
  settingsCache.invalidate();
  if (!hasDatabase()) return false;
  const supabase = getSupabaseServer();
  const { data: project, error } = await supabase.from("projects").select("status, readiness").eq("project_key", projectKey).maybeSingle();
  if (error) throw error;
  if (!project || !canActivateProject(project.status === "ready" || project.status === "approved" || project.readiness >= 100)) return false;

  // One statement in the database: no moment with two active projects or with none.
  if (!activateFunctionMissing) {
    const { error: rpcError } = await supabase.rpc("activate_project", { p_project_key: projectKey });
    if (!rpcError) return true;
    if (rpcError.code !== "PGRST202") throw rpcError;
    activateFunctionMissing = true;
  }

  const previous = await supabase.from("projects").select("project_key").eq("status", "active").neq("project_key", projectKey);
  if (previous.error) throw previous.error;
  const deactivate = await supabase.from("projects").update({ status: "approved" }).eq("status", "active");
  if (deactivate.error) throw deactivate.error;
  const activate = await supabase.from("projects").update({ status: "active", updated_at: new Date().toISOString() }).eq("project_key", projectKey);
  if (activate.error) {
    // The two writes are not one transaction. If the second fails, put the previous project back so clients are not left with no active project.
    const previousKey = previous.data?.[0]?.project_key;
    if (previousKey) await supabase.from("projects").update({ status: "active" }).eq("project_key", previousKey);
    throw activate.error;
  }
  return true;
}
