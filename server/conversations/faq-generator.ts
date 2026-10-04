/**
 * Client FAQ generator — the second knowledge base behind the instant answers.
 *
 * When training is approved, one LLM call turns the approved project facts into
 * the questions a client is likely to ask, each with a ready answer and several
 * phrasings. They are stored in the project snapshot and
 * matched by `matchFaqCache` before the conversation engine is called, so a
 * common question costs one generation up front instead of an LLM call per client.
 */
import crypto from "node:crypto";
import { ENV } from "../_core/env";
import type { invokeLLM } from "../_core/llm";
import { modelForProvider, projectFacts, tidyReply, validateGroundedReply, validateReplyContent } from "./engine";
import { buildFaqCache, needsJudgement, type FaqCache, type FaqEntry, type FaqMatch } from "./faq-cache";
import type { ApprovedProjectSnapshot } from "./project";

const FAQ_COUNT = 15;
// About 110 tokens per question with its phrasings and answer. Groq counts this reservation against its
// tokens-per-minute limit, so it is kept close to what the reply needs.
const MAX_TOKENS = 2600;
// No client is waiting on this call, and the reply is ten times longer than a chat turn.
const GENERATION_TIMEOUT_MS = 60_000;
const MAX_ANSWER_LENGTH = 500;
const MAX_PHRASING_LENGTH = 140;
// An answer that only promises to find out, or points at facts the client cannot see, answers nothing.
const DEFLECTION = /team agent|get back to you|check (?:that |this |it )?with|not sure|don'?t know|refer to|package description|not specified/i;
// What the compiled facts say when the training left something out. To the model these read as facts
// ("Deposit: 0%" became "No deposit is required"), so they are kept out of what it writes from.
const UNSTATED_FACT = /^(?:Price: see the package description|Deposit: 0%|[A-Za-z ]+:\s*(?:Not specified)?|.*(?:is|are) defined in the approved project training\.)$/;

const responseSchema = {
  type: "json_schema" as const,
  json_schema: {
    name: "webasi_client_faqs",
    strict: true,
    schema: {
      type: "object",
      properties: {
        faqs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              q: { type: "string" },
              alt: { type: "array", items: { type: "string" } },
              a: { type: "string" },
            },
            required: ["q", "alt", "a"],
            additionalProperties: false,
          },
        },
      },
      required: ["faqs"],
      additionalProperties: false,
    },
  },
};

const fingerprintCache = new WeakMap<ApprovedProjectSnapshot, string>();

// Changes whenever the knowledge the answers were written from changes, so stored answers can be recognised as out of date.
export function knowledgeFingerprint(project: ApprovedProjectSnapshot) {
  const cached = fingerprintCache.get(project);
  if (cached) return cached;
  const fingerprint = crypto.createHash("sha256").update([projectFacts(project), (project.forbiddenTopics || []).join(","), project.escalationRules ?? ""].join("\n")).digest("hex").slice(0, 16);
  fingerprintCache.set(project, fingerprint);
  return fingerprint;
}

export function buildFaqPrompt(project: ApprovedProjectSnapshot, count = FAQ_COUNT) {
  const facts = projectFacts(project).split("\n").filter((line) => !UNSTATED_FACT.test(line.trim())).join("\n");
  return `You prepare the instant answers for the WhatsApp assistant of ${project.businessName}, which helps potential clients with the ${project.packageName}. Write the questions a client is most likely to ask before ordering, each with the answer the assistant will send word for word. Write up to ${count}; fewer is right when the facts are few.

RULES:
- Use only the approved facts below. Never invent prices, discounts, deadlines, features or guarantees. Leave out any question the facts do not fully answer: when the facts state no price, no deposit or no timeline, write no question about it.
- Leave out discounts, price negotiation, complaints, payment confirmation, bank details, how to order, pay or get started (the assistant handles those steps itself in the chat) and these forbidden topics: ${(project.forbiddenTopics || []).join(", ") || "none"}.
- Spread the questions over everything the facts cover, including each approved FAQ. One question per topic.
- "q": the question in plain English, with no detail the facts do not contain.
- "alt": 4 other short ways a client might type the same question, the way people text on WhatsApp (casual, a few keywords, different words for the same thing).
- "a": the answer. It must make sense without the rest of the chat: 1 or 2 short sentences, no markdown, no em dashes, no greeting, never claiming to be human. Tone: ${project.tone || "warm, concise and helpful"}.
- Write everything in English. Questions in other languages are answered elsewhere.

APPROVED PROJECT FACTS:
${facts}

OUTPUT: one JSON object and nothing else:
{"faqs": [{"q": "<question>", "alt": ["<phrasing>", "<phrasing>", "<phrasing>", "<phrasing>"], "a": "<answer>"}]}`;
}

// A reply cut off by the token limit still holds complete questions before the cut; keep those.
function parseFaqs(content: string): unknown[] {
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = raw.indexOf("{");
  if (start < 0) return [];
  const body = raw.slice(start);
  for (const candidate of [body.slice(0, body.lastIndexOf("}") + 1), `${body.slice(0, body.lastIndexOf("}") + 1)}]}`]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed?.faqs)) return parsed.faqs;
    } catch { /* try the next candidate */ }
  }
  return [];
}

const phrasings = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item && item.length <= MAX_PHRASING_LENGTH && !needsJudgement(item)).slice(0, 5);

// The answer goes to clients without the engine's checks in between, so it has to pass them here.
function approvedAnswer(value: unknown, project: ApprovedProjectSnapshot): string | null {
  if (typeof value !== "string") return null;
  const answer = tidyReply(value);
  if (!answer || answer.length > MAX_ANSWER_LENGTH || DEFLECTION.test(answer)) return null;
  if (!validateGroundedReply(answer, project).valid || !validateReplyContent(answer).valid) return null;
  return answer;
}

export function faqEntriesFromModel(content: string, project: ApprovedProjectSnapshot): FaqEntry[] {
  const entries: FaqEntry[] = [];
  for (const item of parseFaqs(content) as Array<Record<string, unknown>>) {
    const question = typeof item?.q === "string" ? item.q.trim() : "";
    if (!question || question.length > MAX_PHRASING_LENGTH || needsJudgement(question)) continue;
    const answer = approvedAnswer(item.a, project);
    if (!answer) continue;
    entries.push({ question, alternatives: phrasings(item.alt), answer, source: "generated" });
  }
  return entries;
}

export async function generateClientFaqs(project: ApprovedProjectSnapshot, { provider, callModel = modelForProvider(provider, { timeoutMs: GENERATION_TIMEOUT_MS }), count = FAQ_COUNT }: { provider?: string; callModel?: typeof invokeLLM; count?: number } = {}): Promise<FaqEntry[]> {
  const response = await callModel({
    model: ENV.webasiLlmModel, max_tokens: MAX_TOKENS, response_format: responseSchema,
    messages: [{ role: "system", content: buildFaqPrompt(project, count) }, { role: "user", content: "Write the client FAQs now." }],
  });
  const content = response.choices[0]?.message?.content;
  const text = typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
  return faqEntriesFromModel(text, project);
}

// After stating the price the engine asks whether it works for the client, which is what leads to a meeting.
// An instant answer that states the price has to ask too, or the chat stops at the number.
const PRICE_CHECK = "Does that work for your budget?";

export function instantReplyText(match: FaqMatch, project: ApprovedProjectSnapshot, knownFields: Record<string, string | null> = {}) {
  const { answer } = match.entry;
  const statesPrice = project.priceLkr > 0 && answer.replace(/[,\s]/g, "").includes(String(project.priceLkr));
  const alreadyAnswered = knownFields.priceOk === "yes" || knownFields.priceOk === "no";
  return statesPrice && match.language === "english" && !alreadyAnswered ? `${answer}\n\n${PRICE_CHECK}` : answer;
}

const instantAnswersCache = new WeakMap<ApprovedProjectSnapshot, FaqCache>();

// Everything the assistant may answer without the LLM: the owner's own FAQs, always read from the current
// training, plus the generated client FAQs for as long as the knowledge they were written from is unchanged.
export function instantAnswersFor(project: ApprovedProjectSnapshot): FaqCache {
  const cached = instantAnswersCache.get(project);
  if (cached) return cached;
  const generated = project.generatedFaqs?.factsHash === knowledgeFingerprint(project) ? project.generatedFaqs.entries : [];
  const answers = [...buildFaqCache(project.faqs ?? ""), ...generated];
  instantAnswersCache.set(project, answers);
  return answers;
}
