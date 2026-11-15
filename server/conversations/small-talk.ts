import type { ReplyLanguage, ReplyLanguages } from "../../shared/languages";
import { replyLanguageFor } from "../../shared/languages";

// Messages a person answers with a tap or three words, not a paragraph. Catching them here keeps the AI out of the
// cheapest turns and makes the chat read like a person: a thumbs up on "ok", a thank-you reaction, a short goodbye.
export type SmallTalk = "thanks" | "ok" | "bye";

const THANKS = new Set(["thanks", "thank", "thankyou", "thx", "ty", "tnx", "tq", "istuti", "isthuthi", "stuti", "sthuthi", "bohoma", "ස්තුති", "ස්තුතියි", "ස්තූතියි", "බොහොම"]);
const BYE = new Set(["bye", "byee", "byeee", "goodbye", "goodnight", "night", "gn", "ttyl", "tc"]);
const OK = new Set(["ok", "okay", "okey", "oky", "k", "kk", "okk", "alright", "sure", "noted", "got", "it", "yes", "ya", "yeah", "yep", "yup", "hari", "haa", "ha", "hm", "hmm", "hmmm", "ela", "elakiri", "niyamai", "supiri", "great", "perfect", "nice", "cool", "good", "fine", "super", "හරි", "හා", "හොඳයි", "නියමයි"]);
// Words that carry no meaning on their own in these messages: "ok then", "hari ne", "thanks a lot".
const FILLER = new Set(["a", "lot", "so", "much", "then", "ne", "ane", "la", "da", "oi", "bro", "sir", "madam", "machan", "aiya", "akka", "you", "u", "very", "and"]);
const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;

export function classifySmallTalk(text: string): SmallTalk | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40 || /[?\d]/.test(trimmed)) return null;
  const words = trimmed.replace(EMOJI, " ").toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "ok"; // emoji or sticker-like text only
  if (words.length > 4) return null;
  let kind: SmallTalk | null = null;
  for (const word of words) {
    if (BYE.has(word)) kind = "bye";
    else if (THANKS.has(word)) kind = kind === "bye" ? kind : "thanks";
    else if (OK.has(word)) kind ??= "ok";
    else if (!FILLER.has(word)) return null;
  }
  return kind;
}

export const SMALL_TALK_REACTION: Record<Exclude<SmallTalk, "bye">, string> = { thanks: "🙏", ok: "👍" };

const BYE_REPLIES: Record<ReplyLanguage, string[]> = {
  english: ["Sure, talk soon!", "Okay, take care!"],
  singlish: ["Hari, passe katha karamu!", "Okay, take care! Passe kiyanna."],
  sinhala: ["හරි, පසුව කතා කරමු!", "හරි, සුභ දවසක්!"],
};

export function smallTalkReply(language: string | null | undefined, languages: ReplyLanguages, random = Math.random) {
  const wanted = (["english", "singlish", "sinhala"] as const).includes(language as ReplyLanguage) ? (language as ReplyLanguage) : "english";
  const options = BYE_REPLIES[replyLanguageFor(wanted, languages)];
  return options[Math.floor(random() * options.length)];
}
