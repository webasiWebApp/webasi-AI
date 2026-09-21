import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, conversations, InsertConversation, usageCounters, whatsappMessages, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import type { OrderState } from "../shared/webasi";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _db = drizzle(process.env.DATABASE_URL); } catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  for (const field of textFields) {
    if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; }
  }
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function claimWhatsAppMessage(input: { messageId: string; waId: string; messageType: string }): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  try { await db.insert(whatsappMessages).values(input); return true; }
  catch (error: any) { if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) return false; throw error; }
}

export type ConversationSnapshot = {
  clientId: string;
  waId: string;
  profileName?: string;
  state: OrderState;
  isPaused: boolean;
  missingFields: string[];
  extractedFields: Record<string, string | null>;
  recentMessages: Array<{ role: "client" | "assistant"; text: string }>;
  lastClientMessageAt?: Date;
};

const emptyConversation = (clientId: string, waId: string, profileName?: string): ConversationSnapshot => ({
  clientId, waId, profileName, state: "new", isPaused: false,
  missingFields: ["clientName", "contactDetails", "businessName", "businessDescription", "chosenPackage", "budget", "deadline", "existingAssets"],
  extractedFields: {}, recentMessages: [],
});

export async function getConversation(clientId: string, waId: string, profileName?: string): Promise<ConversationSnapshot> {
  const db = await getDb();
  if (!db) return emptyConversation(clientId, waId, profileName);
  const result = await db.select().from(conversations).where(eq(conversations.clientId, clientId)).limit(1);
  const row = result[0];
  if (!row) {
    const initial = emptyConversation(clientId, waId, profileName);
    await db.insert(conversations).values({ clientId, waId, profileName: profileName ?? null, state: initial.state, isPaused: 0, missingFields: JSON.stringify(initial.missingFields), extractedFields: JSON.stringify(initial.extractedFields), recentMessages: JSON.stringify(initial.recentMessages) });
    return initial;
  }
  return {
    clientId: row.clientId, waId: row.waId, profileName: row.profileName ?? undefined, state: row.state as OrderState,
    isPaused: row.isPaused === 1, missingFields: JSON.parse(row.missingFields), extractedFields: JSON.parse(row.extractedFields), recentMessages: JSON.parse(row.recentMessages),
    lastClientMessageAt: row.lastClientMessageAt ?? undefined,
  };
}

export async function saveConversation(snapshot: ConversationSnapshot): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(conversations).set({ waId: snapshot.waId, profileName: snapshot.profileName ?? null, state: snapshot.state, isPaused: snapshot.isPaused ? 1 : 0, missingFields: JSON.stringify(snapshot.missingFields), extractedFields: JSON.stringify(snapshot.extractedFields), recentMessages: JSON.stringify(snapshot.recentMessages), lastClientMessageAt: snapshot.lastClientMessageAt ?? null }).where(eq(conversations.clientId, snapshot.clientId));
}

function currentPeriodKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function currentDayKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; }

export async function getUsageCounts(date = new Date()): Promise<{ outboundWhatsApp: number; geminiRequests: number }> {
  const db = await getDb();
  if (!db) return { outboundWhatsApp: 0, geminiRequests: 0 };
  const period = currentPeriodKey(date);
  const result = await db.select().from(usageCounters).where(eq(usageCounters.periodKey, period)).limit(1);
  const row = result[0];
  return { outboundWhatsApp: row?.outboundWhatsApp ?? 0, geminiRequests: row?.geminiRequests ?? 0 };
}

export async function incrementUsage(field: "outboundWhatsApp" | "geminiRequests", date = new Date()): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const period = currentPeriodKey(date);
  const result = await db.select().from(usageCounters).where(eq(usageCounters.periodKey, period)).limit(1);
  const row = result[0];
  if (!row) {
    await db.insert(usageCounters).values({ periodKey: period, outboundWhatsApp: field === "outboundWhatsApp" ? 1 : 0, geminiRequests: field === "geminiRequests" ? 1 : 0 });
    return;
  }
  await db.update(usageCounters).set({ [field]: (field === "outboundWhatsApp" ? row.outboundWhatsApp : row.geminiRequests) + 1 }).where(eq(usageCounters.periodKey, period));
}

export function customerWindowOpen(lastClientMessageAt: Date | undefined, now = new Date()): boolean {
  if (!lastClientMessageAt) return false;
  return now.getTime() - lastClientMessageAt.getTime() <= 24 * 60 * 60 * 1000;
}

export { currentDayKey };
