/**
 * FAQ Cache — pre-compiled answer lookup to skip the LLM for common questions.
 *
 * Flow:
 *  1. After training is approved, `buildFaqCache` parses the FAQ text into a
 *     structured list of { question, answer, keywords } entries.
 *  2. On each incoming client message, `matchFaqCache` scores every entry
 *     against the client's text using keyword overlap + length penalty.
 *  3. If the best match exceeds the threshold, the cached answer is returned
 *     immediately — no LLM call, no token cost.
 *
 * Design choices:
 *  - Pure keyword matching (no embeddings). Fast, deterministic, zero extra deps.
 *  - Conservative threshold (≥ 0.45) so partial/vague questions fall through
 *    to the engine rather than returning a wrong cached answer.
 *  - Short questions (< 4 words) are never matched to avoid false positives
 *    from greetings and single-word messages.
 *  - Cache object is a plain array — safe to JSON-serialise and store in the
 *    project snapshot so it survives process restarts.
 */

export type FaqEntry = {
  question: string;
  answer: string;
  /** Lowercase keywords extracted from the question, used for scoring. */
  keywords: string[];
};

export type FaqCache = FaqEntry[];

export type FaqMatch = {
  entry: FaqEntry;
  score: number;
};

// ---------------------------------------------------------------------------
// Stop-words: common words that carry no discriminating signal.
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "i", "you", "we", "they",
  "he", "she", "it", "me", "my", "your", "our", "their", "its",
  "and", "or", "but", "so", "if", "then", "that", "this", "these",
  "those", "which", "who", "what", "when", "where", "how", "why",
  "to", "of", "in", "on", "at", "for", "with", "about", "by", "from",
  "up", "out", "as", "into", "through", "during", "before", "after",
  "not", "no", "nor", "any", "much", "many", "some", "please", "hi",
  "hello", "ok", "okay", "yes", "yeah", "yep", "nope",
]);

const MIN_QUESTION_WORDS = 4;
const MATCH_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// Tokenise a string into lowercase, stop-word-filtered keywords.
// ---------------------------------------------------------------------------
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Parse the raw FAQ text (the `answers.faqs` training field) into entries.
//
// Supported formats:
//   Q: <question>\nA: <answer>\n\n...     (standard Q/A format used by appendProjectFaq)
//   <question>\n<answer>\n\n...           (plain two-line format)
// ---------------------------------------------------------------------------
export function buildFaqCache(faqsText: string): FaqCache {
  if (!faqsText?.trim()) return [];

  const cache: FaqCache = [];

  // Split on double-newline paragraph boundaries.
  const blocks = faqsText.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    let question = "";
    let answer = "";

    const firstLine = lines[0];
    if (/^Q:/i.test(firstLine)) {
      // "Q: ... \n A: ..." format
      question = firstLine.replace(/^Q:\s*/i, "").trim();
      const answerLines = lines.slice(1);
      const aLineIdx = answerLines.findIndex((l) => /^A:/i.test(l));
      if (aLineIdx >= 0) {
        answer = answerLines.slice(aLineIdx).join("\n").replace(/^A:\s*/i, "").trim();
      } else {
        answer = answerLines.join("\n").trim();
      }
    } else {
      // Plain two-line format: first line = question, rest = answer.
      question = firstLine;
      answer = lines.slice(1).join("\n").trim();
    }

    if (!question || !answer) continue;

    const keywords = tokenise(question);
    if (keywords.length === 0) continue;

    cache.push({ question, answer, keywords });
  }

  return cache;
}

// ---------------------------------------------------------------------------
// Score a single FAQ entry against an incoming client message.
//
// Score = (matched keywords) / (union of entry keywords + query keywords)
//         i.e. Jaccard-like intersection-over-union on keyword sets.
//
// Returns a value in [0, 1].
// ---------------------------------------------------------------------------
function scoreEntry(queryKeywords: string[], entry: FaqEntry): number {
  if (entry.keywords.length === 0 || queryKeywords.length === 0) return 0;

  const entrySet = new Set(entry.keywords);
  const querySet = new Set(queryKeywords);

  let intersection = 0;
  for (const kw of querySet) if (entrySet.has(kw)) intersection++;

  const union = entrySet.size + querySet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Find the best matching FAQ entry for an incoming client message.
//
// Returns null if:
//  - The question is too short (likely a greeting).
//  - No entry clears the confidence threshold.
// ---------------------------------------------------------------------------
export function matchFaqCache(
  incomingText: string,
  cache: FaqCache,
  threshold = MATCH_THRESHOLD,
): FaqMatch | null {
  if (!cache || cache.length === 0) return null;

  const queryKeywords = tokenise(incomingText);

  // Too vague to match reliably.
  if (queryKeywords.length < MIN_QUESTION_WORDS) return null;

  let best: FaqMatch | null = null;

  for (const entry of cache) {
    const score = scoreEntry(queryKeywords, entry);
    if (score >= threshold && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  return best;
}
