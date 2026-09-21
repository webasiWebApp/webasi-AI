import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const whatsappMessages = mysqlTable("whatsapp_messages", {
  id: int("id").autoincrement().primaryKey(),
  messageId: varchar("messageId", { length: 255 }).notNull().unique(),
  waId: varchar("waId", { length: 32 }).notNull(),
  messageType: varchar("messageType", { length: 32 }).notNull(),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
});

export type WhatsAppMessageRecord = typeof whatsappMessages.$inferSelect;
export type InsertWhatsAppMessage = typeof whatsappMessages.$inferInsert;

export const conversations = mysqlTable("conversations", {
  id: int("id").autoincrement().primaryKey(),
  clientId: varchar("clientId", { length: 80 }).notNull().unique(),
  waId: varchar("waId", { length: 32 }).notNull().unique(),
  profileName: varchar("profileName", { length: 160 }),
  state: mysqlEnum("state", ["new", "collecting", "brief_complete", "awaiting_deposit", "slip_received", "confirmed_by_owner", "needs_owner", "paused", "abandoned", "cancelled"]).default("new").notNull(),
  isPaused: int("isPaused").default(0).notNull(),
  missingFields: text("missingFields").notNull(),
  extractedFields: text("extractedFields").notNull(),
  recentMessages: text("recentMessages").notNull(),
  lastClientMessageAt: timestamp("lastClientMessageAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

export const usageCounters = mysqlTable("usage_counters", {
  id: int("id").autoincrement().primaryKey(),
  periodKey: varchar("periodKey", { length: 20 }).notNull().unique(),
  outboundWhatsApp: int("outboundWhatsApp").default(0).notNull(),
  geminiRequests: int("geminiRequests").default(0).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type UsageCounter = typeof usageCounters.$inferSelect;
export type InsertUsageCounter = typeof usageCounters.$inferInsert;
