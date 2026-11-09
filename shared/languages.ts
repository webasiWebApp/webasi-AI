// Which languages WEBASI may reply in. The owner switches each one on or off in Settings; at least one stays on.
// Singlish is Sinhala written in English letters; Sinhala is Sinhala script.
export const REPLY_LANGUAGES = ["english", "singlish", "sinhala"] as const;
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];
export type ReplyLanguages = Record<ReplyLanguage, boolean>;

export const DEFAULT_REPLY_LANGUAGES: ReplyLanguages = { english: true, singlish: true, sinhala: true };
export const REPLY_LANGUAGE_LABELS: Record<ReplyLanguage, string> = { english: "English", singlish: "Singlish", sinhala: "Sinhala" };

// A missing or damaged value means every language is on, which is how WEBASI behaved before the switches existed.
export function mergeReplyLanguages(stored: unknown): ReplyLanguages {
  const given = stored && typeof stored === "object" ? (stored as Partial<Record<ReplyLanguage, unknown>>) : {};
  const merged = Object.fromEntries(REPLY_LANGUAGES.map((language) => [language, typeof given[language] === "boolean" ? given[language] : DEFAULT_REPLY_LANGUAGES[language]])) as ReplyLanguages;
  return REPLY_LANGUAGES.some((language) => merged[language]) ? merged : { ...DEFAULT_REPLY_LANGUAGES };
}

export const allReplyLanguagesOn = (languages: ReplyLanguages) => REPLY_LANGUAGES.every((language) => languages[language]);

// When the client writes in a language that is switched off, the reply uses the closest one that is on.
const CLOSEST: Record<ReplyLanguage, ReplyLanguage[]> = { english: ["english", "singlish", "sinhala"], singlish: ["singlish", "sinhala", "english"], sinhala: ["sinhala", "singlish", "english"] };
export function replyLanguageFor(clientLanguage: ReplyLanguage, languages: ReplyLanguages): ReplyLanguage {
  return CLOSEST[clientLanguage].find((language) => languages[language]) ?? "english";
}
