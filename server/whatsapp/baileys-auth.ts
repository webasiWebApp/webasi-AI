import crypto from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { BufferJSON, initAuthCreds, type AuthenticationState, type SignalDataTypeMap, type SignalKeyStore } from "baileys";
import { baileysState } from "../../drizzle/schema";
import { getDb } from "../db";
import { ENV } from "../_core/env";

const prefix = "baileys:";
const keyPrefix = "baileys:key:";

function encryptionKey() {
  if (!ENV.baileysSessionEncryptionKey) throw new Error("BAILEYS_SESSION_ENCRYPTION_KEY or JWT_SECRET is required for Baileys session storage");
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
  const db = await getDb(); if (!db) return undefined;
  const rows = await db.select().from(baileysState).where(eq(baileysState.stateKey, stateKey)).limit(1);
  return rows[0] ? open<T>(rows[0].payload) : undefined;
}
async function writeState(stateKey: string, value: unknown) {
  const db = await getDb(); if (!db) return;
  const payload = seal(value);
  await db.insert(baileysState).values({ stateKey, payload }).onDuplicateKeyUpdate({ set: { payload, updatedAt: new Date() } });
}
async function deleteState(stateKey: string) {
  const db = await getDb(); if (!db) return;
  await db.delete(baileysState).where(eq(baileysState.stateKey, stateKey));
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
      const db = await getDb(); if (!db) return;
      await db.delete(baileysState).where(like(baileysState.stateKey, `${keyPrefix}%`));
      await deleteState(`${prefix}creds`);
    },
  };
  return { creds, keys };
}

export async function saveBaileysCreds(creds: AuthenticationState["creds"]) { await writeState(`${prefix}creds`, creds); }
export async function hasBaileysSession() { return Boolean(await readState(`${prefix}creds`)); }
export async function clearBaileysSession() { const state = await getDb(); if (!state) return; await state.delete(baileysState).where(and(like(baileysState.stateKey, `${prefix}%`))); }
