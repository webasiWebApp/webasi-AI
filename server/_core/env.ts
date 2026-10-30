// A limit that is unset, empty, not a number or below `min` falls back to the default. Number("") is 0, so an empty
// BAILEYS_RATE_LIMIT_PER_MINUTE used to mean "never send anything" rather than "use the default".
export function numberFromEnv(value: string | undefined, fallback: number, min = 1): number {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET ?? "",
  whatsappOwnerWaId: process.env.WHATSAPP_OWNER_WA_ID ?? "",
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",
  whatsappGraphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v26.0",
  whatsappMonthlyCap: numberFromEnv(process.env.WHATSAPP_MONTHLY_CAP, 900),
  geminiDailyCap: numberFromEnv(process.env.GEMINI_DAILY_CAP, 500),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
  // The free tier allows 5 requests a minute per model; raise this on a paid plan.
  geminiRpmLimit: numberFromEnv(process.env.GEMINI_RPM_LIMIT, 5),
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  aiProvider: process.env.AI_PROVIDER ?? "gemini",
  webasiEnabled: process.env.WEBASI_ENABLED !== "false",
  webasiLlmModel: process.env.WEBASI_LLM_MODEL ?? "gemini-3-flash-preview",
  // Instant answers are English. Off: a Singlish question always goes to the AI, which replies in Singlish.
  // On: a Singlish question that clearly matches gets the English instant answer, saving the AI request.
  faqEnglishForSinglish: process.env.FAQ_ENGLISH_FOR_SINGLISH === "true",
  whatsappTransport: process.env.WHATSAPP_TRANSPORT ?? "baileys",
  baileysPhoneNumber: process.env.BAILEYS_PHONE_NUMBER ?? "",
  baileysSessionEncryptionKey: process.env.BAILEYS_SESSION_ENCRYPTION_KEY || process.env.JWT_SECRET || "",
  baileysRateLimitPerMinute: numberFromEnv(process.env.BAILEYS_RATE_LIMIT_PER_MINUTE, 8),
  // The PIN that unlocks the dashboard. Production serves nothing but the health checks until it is set.
  dashboardPin: process.env.DASHBOARD_PIN ?? "",
  // Deprecated and ignored: the PIN lock replaced the HTTP Basic password. Kept so a leftover value can be reported.
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  // Requests per minute one address may make to the dashboard API, and the smaller allowance for calls that spend AI requests.
  apiRateLimitPerMinute: numberFromEnv(process.env.API_RATE_LIMIT_PER_MINUTE, 240),
  aiRateLimitPerMinute: numberFromEnv(process.env.AI_RATE_LIMIT_PER_MINUTE, 20),
  // Hours a client may wait in a chat WEBASI is not answering (handed over, or paused by the owner) before the owner
  // gets one reminder. 0 switches the reminders off.
  handoverReminderHours: numberFromEnv(process.env.HANDOVER_REMINDER_HOURS, 2, 0),
  // Days to keep event-log entries and logged messages before they are deleted. 0, the default, keeps everything.
  eventLogRetentionDays: numberFromEnv(process.env.EVENT_LOG_RETENTION_DAYS, 0, 0),
  messageRetentionDays: numberFromEnv(process.env.MESSAGE_RETENTION_DAYS, 0, 0),
};
