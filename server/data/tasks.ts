import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";
import { dbError, refuse, requireDb } from "./errors";
import { recordEvent } from "./events";

const mapTask = (row: any) => ({
  id: row.id as string, jobId: row.job_id as string, position: row.position as number, title: row.title as string, status: row.status as "todo" | "doing" | "done",
  dueDate: (row.due_date ?? null) as string | null, doneAt: (row.done_at ?? null) as string | null, note: (row.note ?? "") as string,
});
export type JobTask = ReturnType<typeof mapTask>;

const supabase = () => getSupabaseServer();

// ----- The template (Settings) ---------------------------------------------------------------------------------------
export async function getTaskTemplate(): Promise<Array<{ id: string; position: number; title: string }>> {
  if (!hasDatabase()) return [];
  const { data, error } = await supabase().from("task_templates").select("*").order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({ id: row.id as string, position: row.position as number, title: row.title as string }));
}

// Add, rename, reorder and remove are one edit: the whole list, in order. Jobs that already started keep their own copy.
export async function replaceTaskTemplate(titles: string[]) {
  requireDb();
  const cleaned = titles.map((title) => title.trim()).filter(Boolean);
  const { error } = await supabase().rpc("replace_task_templates", { p_titles: cleaned });
  if (error) dbError(error);
  await recordEvent({ eventType: "task_template_edited", title: "Task template edited", detail: `The default task list now has ${cleaned.length} tasks.` });
  return getTaskTemplate();
}

// ----- A job's checklist ---------------------------------------------------------------------------------------------
export async function listTasks(jobId: string): Promise<JobTask[]> {
  if (!hasDatabase()) return [];
  const { data, error } = await supabase().from("job_tasks").select("*").eq("job_id", jobId).order("position", { ascending: true });
  if (error) dbError(error);
  return (data ?? []).map(mapTask);
}

async function jobIsOpen(jobId: string) {
  const { data, error } = await supabase().from("jobs").select("stage").eq("id", jobId).maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("NOT_FOUND", "That job does not exist.");
  if (data.stage === "lost") refuse("PRECONDITION_FAILED", "A lost job's checklist cannot be changed.");
}

export async function addTask(jobId: string, title: string, dueDate?: string | null): Promise<JobTask> {
  requireDb();
  await jobIsOpen(jobId);
  const existing = await listTasks(jobId);
  const { data, error } = await supabase().from("job_tasks").insert({ job_id: jobId, position: (existing.at(-1)?.position ?? 0) + 1, title: title.trim(), due_date: dueDate ?? null }).select("*").single();
  if (error) dbError(error);
  return mapTask(data);
}

export async function updateTask(id: string, patch: { title?: string; status?: "todo" | "doing" | "done"; dueDate?: string | null; note?: string }): Promise<JobTask> {
  requireDb();
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.status !== undefined) { set.status = patch.status; set.done_at = patch.status === "done" ? new Date().toISOString() : null; }
  if (patch.dueDate !== undefined) set.due_date = patch.dueDate;
  if (patch.note !== undefined) set.note = patch.note;
  const { data, error } = await supabase().from("job_tasks").update(set).eq("id", id).select("*").maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("NOT_FOUND", "That task does not exist.");
  return mapTask(data);
}

export async function removeTask(id: string) {
  requireDb();
  const { data, error } = await supabase().from("job_tasks").delete().eq("id", id).select("id");
  if (error) dbError(error);
  if (!data?.length) refuse("NOT_FOUND", "That task does not exist.");
  return true;
}

// Moves the tasks into the given order. Ids that do not belong to the job are ignored.
export async function reorderTasks(jobId: string, orderedIds: string[]) {
  requireDb();
  const tasks = await listTasks(jobId);
  const known = new Set(tasks.map((task) => task.id));
  const order = [...orderedIds.filter((id) => known.has(id)), ...tasks.map((task) => task.id).filter((id) => !orderedIds.includes(id))];
  for (const [index, id] of order.entries()) {
    const { error } = await supabase().from("job_tasks").update({ position: index + 1, updated_at: new Date().toISOString() }).eq("id", id).eq("job_id", jobId);
    if (error) dbError(error);
  }
  return listTasks(jobId);
}
