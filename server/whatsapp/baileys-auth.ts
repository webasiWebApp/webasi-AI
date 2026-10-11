import crypto from "node:crypto";
import { BufferJSON, initAuthCreds, type AuthenticationState, type SignalDataTypeMap, type SignalKeyStore } from "baileys";
import { getSupabaseServer } from "../_core/supabase";
import { ENV } from "../_core/env";

const prefix = "baileys:";
const keyPrefix = "baileys:key:";

function encryptionKey() {
  if (!ENV.baileysSessionEncryptionKey || ENV.baileysSessionEncryptionKey.length < 32) {
    throw new Error("BAILEYS_SESSION_ENCRYPTION_KEY or JWT_SECRET with at least 32 characters is required");
  }
  return crypto.createHash("sha256").update(ENV.baileysSessionEncryptionKey).digest();
}
function seal(value: unknown) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value, BufferJSON.replacer)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}
function open<T>(payload: string): T {
  const raw = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  return JSON.parse(body, BufferJSON.reviver) as T;
}

async function readState<T>(stateKey: string): Promise<T | undefined> {
  const { data, error } = await getSupabaseServer().from("baileys_auth_state").select("payload").eq("state_key", stateKey).maybeSingle();
  if (error) throw new Error(`Supabase Baileys read failed: ${error.message}`);
  return data ? open<T>(data.payload) : undefined;
}
async function writeState(stateKey: string, value: unknown) {
  const { error } = await getSupabaseServer().from("baileys_auth_state").upsert({ state_key: stateKey, payload: seal(value), updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase Baileys write failed: ${error.message}`);
}
async function deleteState(stateKey: string) {
  const { error } = await getSupabaseServer().from("baileys_auth_state").delete().eq("state_key", stateKey);
  if (error) throw new Error(`Supabase Baileys delete failed: ${error.message}`);
}

export async function createDatabaseAuthState(): Promise<AuthenticationState> {
  const creds = (await readState<AuthenticationState["creds"]>(`${prefix}creds`)) ?? initAuthCreds();
  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const values: Record<string, SignalDataTypeMap[T]> = {};
      await Promise.all(ids.map(async (id) => {
        const value = await readState<SignalDataTypeMap[T]>(`${keyPrefix}${type}:${id}`);
        if (value !== undefined) values[id] = value;
      }));
      return values;
    },
    async set(data) {
      await Promise.all(Object.entries(data).flatMap(([type, entries]) => Object.entries(entries ?? {}).map(async ([id, value]) => {
        const stateKey = `${keyPrefix}${type}:${id}`;
        if (value === null) await deleteState(stateKey); else await writeState(stateKey, value);
      })));
    },
    async clear() {
      knownSession = null;
      const { error } = await getSupabaseServer().from("baileys_auth_state").delete().like("state_key", `${keyPrefix}%`);
      if (error) throw new Error(`Supabase Baileys clear failed: ${error.message}`);
      await deleteState(`${prefix}creds`);
    },
  };
  return { creds, keys };
}

// Every open dashboard tab asks for the connection status every few seconds, and each answer includes whether a
// session is stored. Remembering that for a short while saves a database read (and a decryption) per poll.
const SESSION_CHECK_TTL_MS = 30_000;
let knownSession: { stored: boolean; at: number } | null = null;

export async function saveBaileysCreds(creds: AuthenticationState["creds"]) { await writeState(`${prefix}creds`, creds); knownSession = { stored: true, at: Date.now() }; }
export async function hasBaileysSession() {
  if (knownSession && Date.now() - knownSession.at < SESSION_CHECK_TTL_MS) return knownSession.stored;
  try {
    const stored = Boolean(await readState(`${prefix}creds`));
    knownSession = { stored, at: Date.now() };
    return stored;
  } catch { return false; }
}
export async function clearBaileysSession() {
  knownSession = null;
  const { error } = await getSupabaseServer().from("baileys_auth_state").delete().like("state_key", `${prefix}%`);
  if (error) throw new Error(`Supabase Baileys clear failed: ${error.message}`);
  knownSession = { stored: false, at: Date.now() };
}
