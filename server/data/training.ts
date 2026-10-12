import { ENV } from "../_core/env";
import { getSupabaseServer } from "../_core/supabase";
import { buildFaqCache, type FaqEntry, type GeneratedFaqs } from "../conversations/faq-cache";
import { generateClientFaqs, knowledgeFingerprint } from "../conversations/faq-generator";
import type { ApprovedProjectSnapshot } from "../conversations/project";
import { incrementUsage } from "../db";
import { parsePriceLkr, splitIncludedExcluded, trainingReadiness } from "../../shared/webasi";
import { compiledSnapshotCache, hasDatabase, invalidateProjectCaches } from "./core";
import { recordEvent } from "./events";
import { getActiveProject, getProjectByKey } from "./projects";
import { getSettings } from "./settings";

export const trainingChecklist = ["packageDescription", "includedExcluded", "pricing", "depositRule", "timeline", "revisionPolicy", "requiredClientInputs", "paymentTerms", "faqs", "tone", "forbiddenTopics", "escalationRules", "samples", "contactDetails"] as const;

export async function getTraining(projectKey: string) {
  const untrained = { projectKey, checklist: trainingChecklist as readonly string[], answers: {} as Record<string, string>, summary: "", approved: false };
  if (!hasDatabase()) return untrained;
  const { data, error } = await getSupabaseServer().from("training_sessions").select("checklist, answers, summary, approved").eq("project_key", projectKey).maybeSingle();
  if (error) throw error;
  return data ? { projectKey, checklist: data.checklist as string[], answers: data.answers as Record<string, string>, summary: data.summary as string, approved: Boolean(data.approved) } : untrained;
}

export async function saveTraining(projectKey: string, answers: Record<string, string>, summary: string) {
  invalidateProjectCaches();
  const readiness = trainingReadiness(trainingChecklist, answers, summary);
  // Training belongs to a project; saving it for a key that does not exist would leave a session nothing can use.
  const current = await getProjectByKey(projectKey);
  if (!current) return false;
  const supabase = getSupabaseServer();
  const { error: sessionError } = await supabase.from("training_sessions").upsert({ project_key: projectKey, checklist: trainingChecklist, answers, summary, updated_at: new Date().toISOString() }, { onConflict: "project_key" });
  if (sessionError) throw sessionError;
  const keepStatus = current.status === "active" || current.status === "approved";
  const { error: projectError } = await supabase.from("projects").update({ ...(keepStatus ? {} : { status: readiness.complete ? "ready" : "training" }), readiness: readiness.readiness, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
  if (projectError) throw projectError;
  return true;
}

// Compiling costs two database reads, and every incoming message needs the result. Returning the same object
// until something changes also lets the conversation engine keep its per-project work (facts text, allowed numbers).
export async function compileProjectSnapshot(projectKey: string) {
  const cached = compiledSnapshotCache.get(projectKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const value = await buildProjectSnapshot(projectKey);
  // A key that matches no project is not remembered: the keys come from requests, and each one would otherwise stay in memory.
  if (value) compiledSnapshotCache.set(projectKey, { value, expiresAt: Date.now() + 30_000 });
  return value;
}

// The stored snapshot holds the facts as they were last approved, and those win over later edits to the training so that
// clients keep getting approved facts. `fromTraining` is the moment of approval: every fact is read from the training
// answers again, which is what makes an edited price or timeline take effect when the owner approves a second time.
async function buildProjectSnapshot(projectKey: string, { fromTraining = false }: { fromTraining?: boolean } = {}): Promise<ApprovedProjectSnapshot | null> {
  const selected = await getProjectByKey(projectKey);
  if (!selected) return null;
  let storedSnapshot: any = null;
  try { storedSnapshot = typeof selected.snapshot === "string" ? JSON.parse(selected.snapshot) : selected.snapshot; } catch {}
  const parsedSnapshot: any = fromTraining ? null : storedSnapshot;

  const training = await getTraining(projectKey);
  const answers = training.answers;
  const answer = (key: string) => answers[key]?.trim() ?? "";
  const listAnswer = (key: string) => answer(key).split(/[\n,;]+/).map((item: string) => item.trim()).filter(Boolean);
  const depositMatch = answer("depositRule").match(/(\d{1,3})\s*%/);
  const scope = splitIncludedExcluded(answer("includedExcluded"));
  const settings = await getSettings();

  return {
    id: selected.projectKey,
    version: selected.version,
    businessName: parsedSnapshot?.businessName ?? settings.businessName,
    packageName: parsedSnapshot?.packageName ?? selected.name,
    packageDescription: parsedSnapshot?.packageDescription ?? (answer("packageDescription") || `${selected.name} project package.`),
    included: parsedSnapshot?.included ?? scope.included,
    excluded: parsedSnapshot?.excluded ?? scope.excluded,
    priceLkr: parsedSnapshot?.priceLkr || parsePriceLkr(answer("pricing")) || parsePriceLkr(answer("packageDescription")),
    depositPercent: parsedSnapshot?.depositPercent ?? (depositMatch ? Number(depositMatch[1]) : 0),
    timelineBusinessDays: parsedSnapshot?.timelineBusinessDays ?? (answer("timeline") || "Not specified"),
    revisionPolicy: parsedSnapshot?.revisionPolicy ?? (answer("revisionPolicy") || "Revision policy is defined in the approved project training."),
    requiredClientInputs: parsedSnapshot?.requiredClientInputs ?? listAnswer("requiredClientInputs"),
    paymentTerms: parsedSnapshot?.paymentTerms ?? (answer("paymentTerms") || "Payment terms are defined in the approved project training."),
    samples: parsedSnapshot?.samples ?? (answer("samples") || ""),
    contactDetails: parsedSnapshot?.contactDetails ?? (answer("contactDetails") || ""),
    tone: parsedSnapshot?.tone ?? (answer("tone") || "clear, concise, and helpful"),
    forbiddenTopics: parsedSnapshot?.forbiddenTopics ?? listAnswer("forbiddenTopics"),
    // Read live from training so approved learned answers reach the bot without re-approving the project.
    faqs: answer("faqs") || storedSnapshot?.faqs || "",
    escalationRules: answer("escalationRules") || storedSnapshot?.escalationRules || "",
    ...(Array.isArray(storedSnapshot?.generatedFaqs?.entries) ? { generatedFaqs: storedSnapshot.generatedFaqs as GeneratedFaqs } : {}),
  };
}

export async function approveTraining(projectKey: string) {
  const session = await getTraining(projectKey);
  if (!trainingReadiness(session.checklist, session.answers, session.summary).complete) return false;
  const current = await getProjectByKey(projectKey);
  if (!current) return false;
  const snapshot = await buildProjectSnapshot(projectKey, { fromTraining: true });
  // Approving the training of the project that is live must leave it live; "approved" would silently take it out of service.
  const status = current.status === "active" ? "active" : "approved";

  const supabase = getSupabaseServer();
  const { error: sessionError } = await supabase.from("training_sessions").update({ approved: true, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
  if (sessionError) throw sessionError;
  const { error: projectError } = await supabase.from("projects").update({ status, readiness: 100, snapshot: snapshot ?? {}, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
  if (projectError) throw projectError;
  invalidateProjectCaches();
  // Write the client FAQs from the knowledge that was just approved.
  await refreshInstantAnswers(projectKey, { regenerate: true }).catch((err) => console.warn("[Training] Client FAQ generation failed (non-fatal)", err));
  return true;
}

// The stored project snapshot holds the generated client FAQs next to the approved facts.
async function writeGeneratedFaqs(projectKey: string, generatedFaqs: GeneratedFaqs) {
  const supabase = getSupabaseServer();
  const { data: current, error: readError } = await supabase.from("projects").select("snapshot").eq("project_key", projectKey).maybeSingle();
  if (readError) throw readError;
  // `faqCache` is where an earlier version kept the parsed owner FAQs; those are now read from the training itself.
  const { faqCache: _legacy, ...existing } = (current?.snapshot && typeof current.snapshot === "object" ? current.snapshot : {}) as Record<string, unknown>;
  const { error } = await supabase.from("projects").update({ snapshot: { ...existing, generatedFaqs }, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
  if (error) throw error;
  invalidateProjectCaches(); // the stored project row just changed
}

/**
 * Keeps the generated client FAQs (the answers WEBASI gives without calling the AI) in step with the project knowledge.
 * `regenerate` asks the AI to write them again: once when training is approved, or when the owner asks for it.
 * Without it the stored answers are kept and marked as current, which is right after an answer was only added.
 */
export async function refreshInstantAnswers(projectKey: string, { regenerate = false }: { regenerate?: boolean } = {}): Promise<FaqEntry[] | null> {
  invalidateProjectCaches();
  const project = await compileProjectSnapshot(projectKey);
  if (!project) return null;
  if (!regenerate && !project.generatedFaqs) return [];

  let entries = project.generatedFaqs?.entries ?? [];
  let generatedAt = project.generatedFaqs?.generatedAt ?? new Date().toISOString();
  if (regenerate) {
    entries = await generateClientFaqs(project, { provider: (await getSettings()).aiProvider });
    generatedAt = new Date().toISOString();
    await incrementUsage("geminiRequests").catch((err) => console.warn("[Training] usage counter failed", err));
  }
  await writeGeneratedFaqs(projectKey, { factsHash: knowledgeFingerprint(project), generatedAt, entries });

  if (regenerate) await recordEvent({ eventType: "faq_cache_built", severity: "info", title: "Client FAQs generated", detail: `${entries.length} likely client question${entries.length === 1 ? "" : "s"} prepared for ${project.packageName}. WEBASI answers these without an AI request.` });
  return entries;
}

// What the Training page shows: the owner's FAQs, the generated ones, and whether those are still in use.
export async function getInstantAnswers(projectKey: string) {
  const project = await compileProjectSnapshot(projectKey);
  const generated = project?.generatedFaqs ?? null;
  return {
    owner: project ? buildFaqCache(project.faqs ?? "") : [],
    generated: generated?.entries ?? [],
    generatedAt: generated?.generatedAt ?? null,
    outOfDate: Boolean(project && generated && generated.factsHash !== knowledgeFingerprint(project)),
    englishForSinglish: ENV.faqEnglishForSinglish,
  };
}

// Removes one generated question that the owner does not want answered this way; the AI answers it again from then on.
export async function removeInstantAnswer(projectKey: string, question: string) {
  invalidateProjectCaches();
  const project = await compileProjectSnapshot(projectKey);
  if (!project?.generatedFaqs) return false;
  const entries = project.generatedFaqs.entries.filter((entry) => entry.question !== question);
  if (entries.length === project.generatedFaqs.entries.length) return false;
  await writeGeneratedFaqs(projectKey, { ...project.generatedFaqs, entries });
  return true;
}

export async function appendProjectFaq(entry: string) {
  const active = await getActiveProject();
  if (!active) throw new Error("Activate a project before adding answers to its knowledge base.");
  const supabase = getSupabaseServer();
  // Generated client FAQs that were already out of date stay out of date: only answers written from the current knowledge are re-stamped below.
  const before = await compileProjectSnapshot(active.projectKey);
  const generatedWereCurrent = Boolean(before?.generatedFaqs && before.generatedFaqs.factsHash === knowledgeFingerprint(before));
  const training = await getTraining(active.projectKey);
  const answers = { ...training.answers, faqs: [training.answers.faqs?.trim(), entry.trim()].filter(Boolean).join("\n\n") };
  const { error } = await supabase.from("training_sessions").upsert({ project_key: active.projectKey, checklist: training.checklist, answers, summary: training.summary, approved: training.approved, updated_at: new Date().toISOString() }, { onConflict: "project_key" });
  if (error) throw error;
  invalidateProjectCaches();
  // The generated client FAQs are still right after an added answer; re-stamp them so they are not treated as out of date.
  if (generatedWereCurrent) await refreshInstantAnswers(active.projectKey).catch((err) => console.warn("[Training] Instant answers refresh failed (non-fatal)", err));
  await recordEvent({ eventType: "knowledge_added", severity: "info", title: "Answer added to knowledge base", detail: `Added to ${active.name} FAQs: ${entry.slice(0, 300)}` });
}
