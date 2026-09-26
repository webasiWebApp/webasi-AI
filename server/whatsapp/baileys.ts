import { DisconnectReason, Browsers, makeWASocket, type WAMessage } from "baileys";
import pino from "pino";
import { createDatabaseAuthState, saveBaileysCreds, hasBaileysSession, clearBaileysSession } from "./baileys-auth";
import { ENV } from "../_core/env";
import { processWhatsAppMessage } from "../conversations/processor";
import { pauseConversationByWaId, recordEvent, recordOwnerMessageByWaId } from "../module-db";
import { notifyOwner } from "../_core/notification";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";

export type BaileysConnectionStatus = "disconnected" | "pairing" | "connecting" | "connected" | "reconnecting" | "reconnect_required";
export type BaileysStatus = { status: BaileysConnectionStatus; phoneNumber?: string; pairingCode?: string; qr?: string; lastError?: string; updatedAt: string; hasSession: boolean };
export type BaileysSendResult = { accepted: boolean; messageId?: string; reason?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function normalizeBaileysPhone(phoneNumber: string) { return phoneNumber.replace(/\D/g, ""); }
export function shouldIgnoreBaileysMessage(remoteJid: string, fromMe: boolean) { return fromMe || !remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast"; }
export function canSendBaileysMessage(times: number[], now = Date.now(), maxPerMinute = ENV.baileysRateLimitPerMinute, minIntervalMs = 2500) { const recent = times.filter((time) => now - time < 60000); const last = recent.at(-1); return recent.length < maxPerMinute && (!last || now - last >= minIntervalMs); }
export function startupFailureStatus(error: unknown): Pick<BaileysStatus, "status" | "lastError"> { return { status: "reconnect_required", lastError: error instanceof Error ? error.message : "baileys_startup_failed" }; }
export function baileysStatusCode(error: unknown): number {
  const value = error as { output?: { statusCode?: unknown }; statusCode?: unknown; data?: { statusCode?: unknown } };
  return Number(value?.output?.statusCode ?? value?.statusCode ?? value?.data?.statusCode ?? 0);
}
// Collects items per key and flushes them together once the key has been quiet for delayMs.
export function createDebouncer<T>(onFlush: (key: string, items: T[]) => void, delayMs: number) {
  const pending = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>();
  const take = (key: string): T[] => { const entry = pending.get(key); if (!entry) return []; clearTimeout(entry.timer); pending.delete(key); return entry.items; };
  return {
    push(key: string, item: T) { const items = [...take(key), item]; pending.set(key, { items, timer: setTimeout(() => onFlush(key, take(key)), delayMs) }); },
    take,
  };
}
export const INBOUND_TEXT_DEBOUNCE_MS = 4000;
export function resetBaileysStatus(): Pick<BaileysStatus, "status" | "lastError"> { return { status: "disconnected", lastError: undefined }; }

class BaileysTransport {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private starting: Promise<void> | null = null;
  private status: BaileysConnectionStatus = "disconnected";
  private pairingCode: string | undefined;
  private qr: string | undefined;
  private phoneNumber: string | undefined;
  private lastError: string | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly recentSends = new Map<string, number[]>();
  private inboundQueue = Promise.resolve();
  // ponytail: in-memory buffer; texts still waiting when the process restarts are dropped, and only the last message ID in a burst is deduplicated.
  private readonly textBuffer = createDebouncer<{ parsed: ParsedWhatsAppMessage; remoteJid: string }>((_waId, items) => {
    this.inboundQueue = this.inboundQueue.then(() => this.processBatch(items)).catch((error) => console.error("[Baileys] inbound processing failed", error));
  }, INBOUND_TEXT_DEBOUNCE_MS);

  async getStatus(): Promise<BaileysStatus> { return { status: this.status, phoneNumber: this.phoneNumber, pairingCode: this.pairingCode, qr: this.qr, lastError: this.lastError, updatedAt: new Date().toISOString(), hasSession: await hasBaileysSession() }; }

  async resetSession() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket = null;
    const reset = resetBaileysStatus();
    this.status = reset.status;
    this.lastError = reset.lastError;
    this.phoneNumber = undefined;
    this.pairingCode = undefined;
    this.qr = undefined;
    this.reconnectAttempt = 0;
    await clearBaileysSession();
    await recordEvent({ eventType: "baileys_session_reset", severity: "warning", title: "WhatsApp session reset", detail: "The stored encrypted linked-device session was cleared by the owner; pairing is required again." });
    return this.getStatus();
  }

  async start() {
    if (this.socket && ["connected", "connecting", "pairing", "reconnecting"].includes(this.status)) return;
    if (this.starting) return this.starting;
    this.starting = this.connect().catch(async (error) => {
      this.socket = null;
      const failure = startupFailureStatus(error);
      this.status = failure.status;
      const statusCode = baileysStatusCode(error);
      this.lastError = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden
        ? `session_invalidated_${statusCode}`
        : failure.lastError;
      await recordEvent({ eventType: "baileys_startup_failed", severity: "error", title: "WhatsApp reconnect required", detail: this.lastError ?? "baileys_startup_failed" });
      await notifyOwner({ title: "WEBASI: WhatsApp reconnect required", content: "WEBASI could not restore the encrypted WhatsApp session. Reconnect from the dashboard; the stored session was not deleted automatically." }).catch(() => false);
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async connect() {
    this.status = this.reconnectAttempt ? "reconnecting" : "connecting";
    const auth = await createDatabaseAuthState();
    this.socket = makeWASocket({ auth, browser: Browsers.macOS("Chrome"), logger: pino({ level: "silent" }), markOnlineOnConnect: true, syncFullHistory: false });
    this.socket.ev.on("creds.update", (creds) => saveBaileysCreds(auth.creds).catch((error) => console.error("[Baileys] credential persistence failed", error)));
    this.socket.ev.on("connection.update", (update) => this.handleConnection(update, auth).catch((error) => console.error("[Baileys] connection update failed", error)));
    this.socket.ev.on("messages.upsert", ({ messages, type }) => { if (type === "notify") this.enqueueInbound(messages); });
    if (!auth.creds.registered) {
      this.status = "pairing";
    }
  }

  private async handleConnection(update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }, auth: Awaited<ReturnType<typeof createDatabaseAuthState>>) {
    if (update.qr && !auth.creds.registered) {
      this.status = "pairing";
      this.qr = update.qr;
      await recordEvent({ eventType: "baileys_qr_ready", title: "WhatsApp QR code ready", detail: "Scan the QR code to connect." });
    }
    if (update.connection === "open") {
      this.status = "connected"; this.pairingCode = undefined; this.qr = undefined; this.reconnectAttempt = 0; this.lastError = undefined;
      try { await this.socket?.sendPresenceUpdate("available"); console.log("[Baileys] Presence set to available"); } catch (_) {}
      await recordEvent({ eventType: "baileys_connected", title: "WhatsApp connected", detail: "The linked-device transport is connected." });
    }
    if (update.connection === "close") {
      const statusCode = baileysStatusCode(update.lastDisconnect?.error);
      this.socket = null;
      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.forbidden) {
        this.status = "reconnect_required"; this.lastError = `session_invalidated_${statusCode}`; this.pairingCode = undefined;
        await recordEvent({ eventType: "baileys_logged_out", severity: "error", title: "WhatsApp reconnect required", detail: "The linked-device session was invalidated. Reconnect WhatsApp from the dashboard." });
        await notifyOwner({ title: "WEBASI: WhatsApp reconnect required", content: "The Baileys linked-device session was logged out or invalidated. Open Connect WhatsApp and pair the number again." }).catch(() => false);
      } else {
        this.status = "reconnecting"; this.reconnectAttempt += 1;
        const delay = Math.min(30000, 1000 * (2 ** Math.min(this.reconnectAttempt, 5)));
        clearTimeout(this.reconnectTimer); this.reconnectTimer = setTimeout(() => this.start().catch((error) => console.error("[Baileys] reconnect failed", error)), delay);
        await recordEvent({ eventType: "baileys_reconnecting", severity: "warning", title: "WhatsApp reconnecting", detail: `Connection closed; retry ${this.reconnectAttempt} scheduled.` });
      }
    }
  }

  private enqueueInbound(messages: WAMessage[]) {
    for (const message of messages) {
      this.inboundQueue = this.inboundQueue.then(() => this.handleInbound(message)).catch((error) => console.error("[Baileys] inbound processing failed", error));
    }
  }

  private async handleInbound(message: WAMessage) {
    try {
      const remoteJid = message.key.remoteJid ?? "";
      if (shouldIgnoreBaileysMessage(remoteJid, Boolean(message.key.fromMe))) { if (message.key.fromMe && remoteJid) { const ownerText = message.message?.conversation ?? message.message?.extendedTextMessage?.text ?? ""; await pauseConversationByWaId(remoteJid.split("@")[0]); if (ownerText) await recordOwnerMessageByWaId(remoteJid.split("@")[0], ownerText); } return; }
      const waId = remoteJid.split("@")[0];
      const content = message.message;
      if (!content) return;
      const image = content.imageMessage;
      const text = content.conversation ?? content.extendedTextMessage?.text ?? image?.caption;
      const type = image ? "image" : text ? "text" : content.audioMessage ? "audio" : "unsupported";
      const parsed: ParsedWhatsAppMessage = { id: message.key.id ?? `${waId}-${Date.now()}`, from: waId, waId, profileName: message.pushName ?? undefined, type, text: text ? { body: text } : undefined, image: image ? { id: message.key.id ?? undefined, caption: image.caption ?? undefined, mime_type: image.mimetype ?? undefined } : undefined };
      await recordEvent({ eventType: "baileys_message_received", title: "WhatsApp message received", detail: `${type} message from ${message.pushName ?? waId} (${remoteJid}).`, clientId: `baileys:${waId}` });
      if (type === "text") { this.textBuffer.push(waId, { parsed, remoteJid }); return; }
      await this.processBatch(this.textBuffer.take(waId));
      await this.processBatch([{ parsed, remoteJid }]);
    } catch (error) {
      console.error("[Baileys] Unexpected error handling inbound message", error);
    }
  }

  // Rapid consecutive texts from one client become a single turn so WEBASI answers once.
  private async processBatch(items: Array<{ parsed: ParsedWhatsAppMessage; remoteJid: string }>) {
    const last = items.at(-1);
    if (!last) return;
    const body = items.map((item) => item.parsed.text?.body ?? "").filter(Boolean).join("\n");
    const parsed = items.length > 1 ? { ...last.parsed, text: { body } } : last.parsed;
    await processWhatsAppMessage(parsed, { sendText: (input) => this.sendText({ ...input, to: last.remoteJid }) });
  }

  async startPairing() {
    await this.start();
    const deadline = Date.now() + 15000;
    while (!this.qr && Date.now() < deadline && this.status !== "reconnect_required") await sleep(250);
    if (!this.qr) throw new Error(this.lastError ?? "QR code is not ready yet; try again in a moment");
    return this.qr;
  }

  async sendText(input: { to: string; body: string }): Promise<BaileysSendResult> {
    if (!this.socket || this.status !== "connected") {
      console.warn(`[Baileys] Cannot send: socket=${!!this.socket} status=${this.status}`);
      return { accepted: false, reason: "baileys_not_connected" };
    }
    const jid = input.to.includes("@") ? input.to : `${input.to}@s.whatsapp.net`;
    const now = Date.now(); const recent = (this.recentSends.get(jid) ?? []).filter((time) => now - time < 60000);
    if (!canSendBaileysMessage(recent, now)) {
      const last = recent.at(-1);
      if (recent.length >= ENV.baileysRateLimitPerMinute) return { accepted: false, reason: "baileys_rate_limited" };
      if (last) await sleep(Math.max(0, 2500 - (now - last)));
    }
    try {
      await this.socket.presenceSubscribe(jid);
      await sleep(200);
      await this.socket.sendPresenceUpdate("composing", jid);
      await sleep(500);
      await this.socket.sendPresenceUpdate("paused", jid);
      const sent = await this.socket.sendMessage(jid, { text: input.body });
      console.log(`[Baileys] Message sent to ${jid}, key=${sent?.key?.id}`);
      this.recentSends.set(jid, [...recent, Date.now()]);
      await recordEvent({ eventType: "baileys_message_sent", title: "WhatsApp message sent", detail: `Reply sent to ${jid}.`, clientId: `baileys:${input.to}` });
      return { accepted: true, messageId: sent?.key?.id ?? undefined };
    } catch (error) {
      console.error(`[Baileys] sendMessage FAILED for ${jid}:`, error);
      return { accepted: false, reason: `send_failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export const baileysTransport = new BaileysTransport();
export async function startBaileysTransport() { if (ENV.whatsappTransport === "baileys") await baileysTransport.start(); }
