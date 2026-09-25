import { ENV } from "./env";
import type { InvokeParams, InvokeResult, MessageContent } from "./llm";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart = { text: string };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

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
  const configured = requestedModel || ENV.geminiModel || "gemini-3.8-flash";
  return configured.replace(/^models\//, "");
}

export async function invokeGemini(input: InvokeParams): Promise<InvokeResult> {
  if (!ENV.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured");
  const selectedModel = modelName(input.model);
  const system = input.messages.filter((message) => message.role === "system").map((message) => contentToText(message.content)).join("\n\n");
  const contents: GeminiContent[] = input.messages.filter((message) => message.role !== "system" && (message.role === "user" || message.role === "assistant")).map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: contentToText(message.content) }] }));
  const responseSchema = schemaFromResponseFormat(input.response_format ?? input.responseFormat);
  const generationConfig: Record<string, unknown> = { maxOutputTokens: input.max_tokens ?? input.maxTokens ?? 900 };
  if (responseSchema) { generationConfig.responseMimeType = "application/json"; generationConfig.responseSchema = responseSchema; }
  let response: Response;
  let body: GeminiResponse;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(ENV.geminiApiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents, generationConfig }) });
    body = await response.json() as GeminiResponse;
    if (response.ok || attempt >= 2 || ![429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  if (!response.ok) throw new Error(body.error?.message ?? `Gemini request failed with status ${response.status}`);
  const content = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  if (!content) throw new Error("Gemini returned an empty response");
  return { id: `gemini-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: selectedModel, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}
