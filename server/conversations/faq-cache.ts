/**
 * FAQ Cache — pre-compiled answer lookup to skip the LLM for common questions.
 *
 * Two sources feed it (see `instantAnswersFor` in faq-generator.ts):
 *  1. The FAQs the owner typed in training, parsed by `buildFaqCache`.
 *  2. The client FAQs generated once from the approved knowledge when training
 *     is approved: each has several phrasings a client might type.
 *
 * On each incoming client message, `matchFaqCache` scores every phrasing of
 * every entry against the client's text. If the best one clears the threshold,
 * its answer is sent as is — no LLM call, no token cost.
 *
 * Design choices:
 *  - Keyword matching (no embeddings). Fast, deterministic, zero extra deps.
 *  - A wrong instant answer is worse than a slow right one, so when in doubt the
 *    message falls through to the engine:
 *      · a word no FAQ contains counts extra, so "price for 10 pages" does not
 *        get the plain "price" answer;
 *      · the message must contain the word the entry is about, so "I need a
 *        restaurant website" does not get the answer to "restaurant website price";
 *      · anything that needs judgement (discounts, complaints, payments already
 *        made, a client ready to order) is never answered from the cache.
 *  - An answer is only sent to a client writing in the language it is written
 *    in. The generated answers are English, so a Singlish or Sinhala question
 *    goes to the engine, which replies in the client's language.
 *  - Entries are plain objects — safe to JSON-serialise and store in the
 *    project snapshot so they survive process restarts.
 */

export type FaqEntry = {
  question: string;
  answer: string;
  /** Other ways a client may type the same question. */
  alternatives?: string[];
  source?: "owner" | "generated";
};

export type FaqCache = FaqEntry[];

export type FaqMatch = {
  entry: FaqEntry;
  score: number;
  /** The language the answer is written in. */
  language: Language;
};

/** The generated client FAQs as stored in the project snapshot. */
export type GeneratedFaqs = {
  /** Fingerprint of the knowledge the answers were written from; a mismatch means they are out of date. */
  factsHash: string;
  generatedAt: string;
  entries: FaqEntry[];
};

// ---------------------------------------------------------------------------
// Stop-words: common words that carry no discriminating signal.
// "not" is deliberately absent: "what is not included" and "what is included"
// are different questions.
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "i", "you", "we", "they",
  "he", "she", "it", "me", "my", "your", "our", "their", "its", "us", "im",
  "and", "or", "but", "so", "if", "then", "that", "this", "these",
  "those", "which", "who", "what", "when", "where", "how", "why", "there",
  "to", "of", "in", "on", "at", "for", "with", "about", "by", "from",
  "up", "out", "as", "into", "through", "during", "before", "after",
  "no", "nor", "any", "much", "many", "some", "please", "pls", "plz", "hi",
  "hello", "hey", "ok", "okay", "yes", "yeah", "yep", "nope", "thanks", "thank",
  "want", "need", "know", "tell", "like", "just", "also", "sir", "madam", "bro", "guy", "guys",
  "take", "get", "got", "give", "make", "going", "gonna", "let", "see", "look",
  "really", "actually", "now", "here", "too", "again", "still", "well", "sure",
]);

// Singlish (Sinhala typed in English letters). These carry no signal either, and one of them in a
// message says the client is not writing in English.
const SINGLISH_WORDS = new Set([
  "eka", "ekak", "ekata", "eke", "da", "mata", "mama", "oya", "oyala", "oyage", "ape",
  "kohomada", "kohomda", "kohomd", "mokakda", "mokadda", "mokada", "monawada", "kiyada", "keeyada", "kiyak", "kiyala",
  "kiyanna", "kiyannako", "kochchara", "puluwanda", "puluwan", "thiyenawada", "tiyenawada", "thiyenawa", "tiyenawa",
  "wenawa", "wenawada", "wenne", "yanawada", "karanna", "karala", "karamu", "ganna", "hadanna", "balanna", "oni", "ona", "onee",
  "nam", "neda", "nadda", "nathi", "naha", "nehe", "gena", "dawas", "passe", "dannawada", "denna", "danna", "ewanna", "ewannada",
  "kenekda", "machan", "aiye", "ayye", "ayya",
  // the same words as clients actually type them
  "ekk", "kohomad", "puluvn", "puluwn", "puluvan", "balann", "venne", "venava", "mkdd", "mokadd", "kiyanne", "krl", "krnna",
  "hode", "hodai", "thamai", "habai", "ehenm", "ehenam", "denavada", "denawada", "therenne",
]);

// Different words for the same thing, so "cost", "charges" and "gana" all meet "price".
const CANONICAL: Record<string, string> = {
  cost: "price", pricing: "price", charge: "price", charges: "price", fee: "price", fees: "price", rate: "price", rates: "price",
  gana: "price", ganana: "price", mila: "price",
  duration: "long", timeline: "long",
  dont: "not", cant: "not", wont: "not", doesnt: "not", isnt: "not", excluded: "not",
};

// These are never answered from the cache: a discount request, a complaint, a comparison with another provider,
// an attempt to change the rules or a payment already made each need the engine or the owner. So does a client
// who wants to go ahead: the engine takes the order from there, and it is what tells the owner about a hot lead.
const NEEDS_JUDGEMENT = /discount|cheap|expensive|too much|reduce|lower|\bless\b|refund|cancel|complain|scam|fraud|angry|worst|unhappy|not happy|disappoint|competitor|other (?:company|provider|agency|place)|ignore|instruction|prompt|\bpaid\b|\bslip\b|transferred|deposited|\badu\b|wadi|go ahead|proceed|ready to|get(?:ting)? started|let'?s (?:start|begin|do)|(?:start|begin) (?:the|my|a|our) (?:project|work|order)|how (?:do i|can i|to) (?:pay|order|start|begin)/i;

const MATCH_THRESHOLD = 0.6;
// A long message carries details the engine has to read, even when part of it is a known question.
const MAX_QUESTION_LENGTH = 200;
// How much a keyword that appears in no FAQ counts against a match, next to 1 for a known keyword.
const UNKNOWN_KEYWORD_WEIGHT = 1.5;

export function needsJudgement(text: string) {
  return NEEDS_JUDGEMENT.test(text);
}

export type Language = "english" | "singlish" | "other";

// Coarse on purpose: it only has to keep an answer in one language away from a client writing in another.
function languageOf(text: string): Language {
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text)) return "other";
  return text.toLowerCase().split(/[^a-z]+/).some((w) => SINGLISH_WORDS.has(w)) ? "singlish" : "english";
}

// "pages" / "page", "included" / "includes", "hosting" / "host" should meet. Both sides go through the same
// rules, so an odd-looking stem is harmless.
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}

// ---------------------------------------------------------------------------
// Tokenise a string into lowercase, stop-word-filtered keywords.
// Works on any script, so FAQs written in Sinhala match too.
// ---------------------------------------------------------------------------
function tokenise(text: string): string[] {
  const isStopWord = (w: string) => STOP_WORDS.has(w) || SINGLISH_WORDS.has(w);
  return text
    .toLowerCase()
    .normalize("NFKC")
    // "much" is a stop-word, so without this "how much is it?" would have no keywords at all.
    .replace(/\bhow\s+much\b/g, " price ")
    .replace(/\b(?:ca|wo|do|does|did|is|are|was|could|would|should)n['’]t\b/g, " not ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !isStopWord(w))
    .map((w) => stem(CANONICAL[w] ?? w))
    .filter((w) => !isStopWord(w));
}

// ---------------------------------------------------------------------------
// Parse the raw FAQ text (the `answers.faqs` training field) into entries.
//
// Supported formats:
//   Q: <question>\nA: <answer>\n\n...     (standard Q/A format used by appendProjectFaq)
//   <question>\n<answer>\n\n...           (plain two-line format)
// A blank line between two FAQs is easy to forget, so in the plain format a line ending in "?"
// after an answer starts the next question.
// ---------------------------------------------------------------------------
export function buildFaqCache(faqsText: string): FaqCache {
  if (!faqsText?.trim()) return [];

  const cache: FaqCache = [];

  // Split on double-newline paragraph boundaries.
  const blocks = faqsText.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);

    let question = "";
    let answerLines: string[] = [];
    const flush = () => {
      const answer = answerLines.join("\n").trim();
      if (question && answer && tokenise(question).length > 0) cache.push({ question, answer, source: "owner" });
      question = "";
      answerLines = [];
    };

    for (const line of lines) {
      const isAnswerLine = /^A:/i.test(line);
      const startsQuestion = /^Q:/i.test(line) || (answerLines.length > 0 && line.endsWith("?") && !isAnswerLine);
      if (!question || startsQuestion) {
        flush();
        question = line.replace(/^Q:\s*/i, "").trim();
      } else if (isAnswerLine) {
        // "Q: ... \n A: ..." format: the answer starts at the A: line.
        answerLines = [line.replace(/^A:\s*/i, "").trim()];
      } else {
        answerLines.push(line);
      }
    }
    flush();
  }

  return cache;
}

// ---------------------------------------------------------------------------
// Index: every phrasing of every entry as a keyword set, plus what each entry
// is about and every keyword the FAQs know. Built once per cache array.
// ---------------------------------------------------------------------------
type Phrasing = { entry: FaqEntry; language: Language; keywords: Set<string>; subject: Set<string> | null };
type FaqIndex = { phrasings: Phrasing[]; known: Set<string> };

const indexCache = new WeakMap<FaqCache, FaqIndex>();

function indexFor(cache: FaqCache): FaqIndex {
  const cached = indexCache.get(cache);
  if (cached) return cached;

  const phrasings: Phrasing[] = [];
  const known = new Set<string>();
  const subjectUses = new Map<string, number>();

  for (const entry of cache) {
    const language = languageOf(entry.answer);
    const keywordSets = [entry.question, ...(entry.alternatives ?? [])].map((phrasing) => new Set(tokenise(phrasing))).filter((keywords) => keywords.size > 0);

    // The subject is the keyword most of the entry's phrasings share: "price" in every way of asking the price.
    // The other words ("website", "package") come and go, and a message with only those is about something else.
    const counts = new Map<string, number>();
    for (const keywords of keywordSets) keywords.forEach((kw) => { known.add(kw); counts.set(kw, (counts.get(kw) ?? 0) + 1); });
    const most = Math.max(0, ...Array.from(counts.values()));
    const subject = keywordSets.length >= 3 && most >= 2 ? new Set(Array.from(counts.entries()).filter(([, count]) => count === most).map(([kw]) => kw)) : null;

    for (const keywords of keywordSets) phrasings.push({ entry, language, keywords, subject });
    subject?.forEach((kw) => subjectUses.set(kw, (subjectUses.get(kw) ?? 0) + 1));
  }

  // A client often types just the subject ("price?", "revisions?"). When a single word is what one entry, and
  // only that entry, is about, the word alone is a way of asking it.
  const entriesSeen = new Set<FaqEntry>();
  for (const { entry, language, subject } of [...phrasings]) {
    if (entriesSeen.has(entry)) continue;
    entriesSeen.add(entry);
    if (subject?.size === 1 && subjectUses.get(Array.from(subject)[0]) === 1) phrasings.push({ entry, language, keywords: subject, subject });
  }

  const index: FaqIndex = { phrasings, known };
  indexCache.set(cache, index);
  return index;
}

// ---------------------------------------------------------------------------
// Score one phrasing against an incoming client message.
//
// Score = shared keywords / all keywords on either side, i.e. intersection-over-union
//         on the keyword sets, with a keyword no FAQ knows counting extra.
//
// Returns a value in [0, 1].
// ---------------------------------------------------------------------------
function scorePhrasing(queryKeywords: Set<string>, phrasingKeywords: Set<string>, known: Set<string>): number {
  let shared = 0;
  let all = 0;
  queryKeywords.forEach((kw) => {
    if (phrasingKeywords.has(kw)) { shared += 1; all += 1; }
    else all += known.has(kw) ? 1 : UNKNOWN_KEYWORD_WEIGHT;
  });
  phrasingKeywords.forEach((kw) => {
    if (!queryKeywords.has(kw)) all += 1;
  });
  return all === 0 ? 0 : shared / all;
}

// ---------------------------------------------------------------------------
// Find the best matching FAQ entry for an incoming client message.
//
// Returns null if:
//  - The message has no keywords (a greeting, "ok", an emoji).
//  - The message is long or needs judgement (see NEEDS_JUDGEMENT).
//  - No entry answers in the language the client is writing in. With `englishForSinglish`, a Singlish
//    question may get an English answer; its Singlish words still have to be ones this file knows.
//  - No entry clears the confidence threshold.
// ---------------------------------------------------------------------------
export function matchFaqCache(
  incomingText: string,
  cache: FaqCache,
  { threshold = MATCH_THRESHOLD, englishForSinglish = false }: { threshold?: number; englishForSinglish?: boolean } = {},
): FaqMatch | null {
  if (!cache || cache.length === 0) return null;
  if (incomingText.length > MAX_QUESTION_LENGTH || needsJudgement(incomingText)) return null;

  const queryKeywords = new Set(tokenise(incomingText));
  if (queryKeywords.size === 0) return null;

  const { phrasings, known } = indexFor(cache);
  const queryLanguage = languageOf(incomingText);
  let best: FaqMatch | null = null;

  for (const { entry, language, keywords, subject } of phrasings) {
    if (language !== queryLanguage && !(englishForSinglish && queryLanguage === "singlish" && language === "english")) continue;
    if (subject && !Array.from(subject).some((kw) => queryKeywords.has(kw))) continue;
    const score = scorePhrasing(queryKeywords, keywords, known);
    if (score < threshold) continue;
    // On a tie the owner's own wording wins over a generated answer.
    if (!best || score > best.score || (score === best.score && entry.source === "owner" && best.entry.source !== "owner")) {
      best = { entry, score, language };
    }
  }

  return best;
}
