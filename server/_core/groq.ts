import { ENV } from "./env";
import type { InvokeParams, InvokeResult, MessageContent, Message, Tool, ToolChoice, OutputSchema, ResponseFormat } from "./llm";

export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

const requestTimestamps: number[] = [];
let rateLimitMutex = Promise.resolve();

async function acquireRateLimit() {
  const current = rateLimitMutex;
  let release!: () => void;
  rateLimitMutex = new Promise(resolve => { release = resolve; });
  await current;
  
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > 60000) {
    requestTimestamps.shift();
  }
  // Groq rate limit (assuming 30 requests per minute for free tier fallback)
  if (requestTimestamps.length >= 30) {
    const oldest = requestTimestamps[0];
    const waitTime = 60000 - (now - oldest);
    if (waitTime > 0) await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  requestTimestamps.push(Date.now());
  release();
}

function normalizeContent(content: MessageContent | MessageContent[]): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts.map((part) => typeof part === "string" ? part : part.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function normalizeMessage(message: Message) {
  return {
    role: message.role,
    name: message.name,
    content: normalizeContent(message.content),
  };
}

export async function invokeGroq(input: InvokeParams): Promise<InvokeResult> {
  if (!ENV.groqApiKey) throw new Error("GROQ_API_KEY is not configured");
  
  // For Groq, use the requested model or default to openai/gpt-oss-120b
  let selectedModel = input.model || ENV.webasiLlmModel || "openai/gpt-oss-120b";
  if (selectedModel.toLowerCase().includes("gemini")) {
    selectedModel = "openai/gpt-oss-120b";
  }
  
  const payload: any = {
    model: selectedModel,
    messages: input.messages.map(normalizeMessage),
  };

  if (input.max_tokens ?? input.maxTokens) {
    payload.max_tokens = input.max_tokens ?? input.maxTokens;
  }
  
  const responseFormat = input.response_format ?? input.responseFormat;
  if (responseFormat && responseFormat.type === "json_object") {
    payload.response_format = { type: "json_object" };
    payload.messages.push({ role: "system", content: "Please return your response in JSON format." });
  } else if (responseFormat && responseFormat.type === "json_schema") {
    // Groq doesn't natively support structured outputs via json_schema the exact way OpenAI does yet,
    // so we can fallback to json_object if needed, or pass it if the model supports it.
    // For now we'll pass json_object to be safe and let system prompts do the structure.
    payload.response_format = { type: "json_object" };
    payload.messages.push({ role: "system", content: "Please return your response in JSON format matching the schema." });
  }
  
  let response: Response | undefined;
  let body: any;
  
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await acquireRateLimit();
    response = await fetch(GROQ_BASE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ENV.groqApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    body = await response.json();
    if (response.ok) break;
    
    const isRateLimit = response.status === 429 || body?.error?.message?.toLowerCase().includes("rate limit") || body?.error?.message?.toLowerCase().includes("capacity");
    if (!isRateLimit && ![500, 502, 503, 504].includes(response.status)) break;
    if (attempt >= 3) break;
    
    let delayMs = 500 * (attempt + 1);
    if (isRateLimit) delayMs = 2000 * (attempt + 1); // simple backoff
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  
  if (!response?.ok) {
    const isRateLimit = response?.status === 429 || body?.error?.message?.toLowerCase().includes("rate limit") || body?.error?.message?.toLowerCase().includes("capacity");
    if (isRateLimit) throw new RateLimitExceededError(body?.error?.message ?? "Groq API rate limit exceeded");
    throw new Error(body?.error?.message ?? `Groq request failed with status ${response?.status}`);
  }
  
  return {
    id: body.id ?? `groq-${Date.now()}`,
    created: body.created ?? Math.floor(Date.now() / 1000),
    model: selectedModel,
    choices: body.choices ?? [{
      index: 0,
      message: { role: "assistant", content: "" },
      finish_reason: "stop",
    }],
    usage: body.usage,
  };
}
