import { ENV } from "./env";
import type { InvokeParams, InvokeResult, MessageContent } from "./llm";
import { createMinuteLimiter, LLM_REQUEST_TIMEOUT_MS, RateLimitExceededError, type InvokeOptions } from "./rate-limit";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart = { text: string };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

export { RateLimitExceededError };

const acquireRateLimit = createMinuteLimiter(ENV.geminiRpmLimit);

function contentToText(content: MessageContent | MessageContent[]): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts.map((part) => typeof part === "string" ? part : part.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function schemaFromResponseFormat(input: InvokeParams["response_format"]): Record<string, unknown> | undefined {
  if (!input || input.type !== "json_schema") return undefined;
  const convert = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    if (Array.isArray(source.type)) {
      const nonNull = source.type.find((type) => type !== "null");
      if (nonNull) result.type = nonNull;
      if (source.type.includes("null")) result.nullable = true;
    } else if (source.type) result.type = source.type;
    for (const key of ["description", "required", "enum", "format", "nullable", "items"]) if (source[key] !== undefined) result[key] = key === "items" ? convert(source[key]) : source[key];
    if (source.properties && typeof source.properties === "object") result.properties = Object.fromEntries(Object.entries(source.properties as Record<string, unknown>).map(([key, child]) => [key, convert(child)]));
    return result;
  };
  return convert(input.json_schema.schema) as Record<string, unknown>;
}

function modelName(requestedModel?: string) {
  // A non-Gemini name (a Groq model, when Gemini is answering as the backup provider) falls back to the configured Gemini model.
  const requested = requestedModel?.replace(/^models\//, "");
  const configured = requested?.startsWith("gemini") ? requested : ENV.geminiModel || "gemini-3.8-flash";
  return configured.replace(/^models\//, "");
}

export async function invokeGemini(input: InvokeParams, { failFast = false }: InvokeOptions = {}): Promise<InvokeResult> {
  if (!ENV.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured");
  const selectedModel = modelName(input.model);
  const system = input.messages.filter((message) => message.role === "system").map((message) => contentToText(message.content)).join("\n\n");
  const contents: GeminiContent[] = input.messages.filter((message) => message.role !== "system" && (message.role === "user" || message.role === "assistant")).map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: contentToText(message.content) }] }));
  const responseSchema = schemaFromResponseFormat(input.response_format ?? input.responseFormat);
  const generationConfig: Record<string, unknown> = { maxOutputTokens: input.max_tokens ?? input.maxTokens ?? 900 };
  if (responseSchema) { generationConfig.responseMimeType = "application/json"; generationConfig.responseSchema = responseSchema; }
  // Gemini 3 "thinks" at a high level by default: measured ~4.3s per WhatsApp reply against ~1.7s at "low",
  // and the thinking tokens come out of maxOutputTokens, which can cut the JSON reply short.
  let thinkingConfig: Record<string, unknown> | undefined = /^gemini-3/.test(selectedModel) ? { thinkingLevel: "low" } : undefined;
  let response: Response | undefined;
  let body: GeminiResponse | undefined;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await acquireRateLimit({ wait: !failFast }))) throw new RateLimitExceededError("Gemini requests-per-minute limit reached");
    try {
      response = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(ENV.geminiApiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents, generationConfig: thinkingConfig ? { ...generationConfig, thinkingConfig } : generationConfig }), signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS) });
      body = await response.json() as GeminiResponse;
    } catch (error) {
      // Network error or timeout: one more try, then let the caller fall back.
      if (failFast || attempt >= 1) throw error;
      continue;
    }
    if (response.ok) break;
    // A model that does not take thinking levels rejects the field; ask again without it.
    if (response.status === 400 && thinkingConfig) { thinkingConfig = undefined; continue; }

    const isRateLimit = response.status === 429 || body.error?.message?.toLowerCase().includes("quota") || body.error?.message?.toLowerCase().includes("resource_exhausted");
    if (!isRateLimit && ![500, 502, 503, 504].includes(response.status)) break;
    if (attempt >= 3 || (failFast && (isRateLimit || attempt >= 1))) break;

    let delayMs = 500 * (attempt + 1);
    if (isRateLimit && body.error?.message) {
      const match = body.error.message.match(/Please retry in (\d+(?:\.\d+)?)s/);
      if (match) delayMs = parseFloat(match[1]) * 1000;
      else delayMs = 2000 * (attempt + 1);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  
  if (!response?.ok) {
    const isRateLimit = response?.status === 429 || body?.error?.message?.toLowerCase().includes("quota") || body?.error?.message?.toLowerCase().includes("resource_exhausted");
    if (isRateLimit) throw new RateLimitExceededError(body?.error?.message ?? "Gemini API rate limit exceeded");
    throw new Error(body?.error?.message ?? `Gemini request failed with status ${response?.status}`);
  }
  
  const content = body?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!content) throw new Error("Gemini returned an empty response");
  return { id: `gemini-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: selectedModel, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}
