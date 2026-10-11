import { DisconnectReason, Browsers, jidNormalizedUser, makeWASocket, normalizeMessageContent, type WAMessage, type WAMessageKey } from "baileys";
import pino from "pino";
import { createDatabaseAuthState, saveBaileysCreds, hasBaileysSession, clearBaileysSession } from "./baileys-auth";
import { ENV } from "../_core/env";
import { processWhatsAppMessage } from "../conversations/processor";
import { captureLearnedAnswer, pauseConversationByWaId, recordEvent, recordOwnerMessageByWaId } from "../module-db";
import { notifyOwner } from "../_core/notification";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";

export type BaileysConnectionStatus = "disconnected" | "pairing" | "connecting" | "connected" | "reconnecting" | "reconnect_required";
export type BaileysStatus = { status: BaileysConnectionStatus; phoneNumber?: string; pairingCode?: string; qr?: string; lastError?: string; updatedAt: string; hasSession: boolean };
export type BaileysSendResult = { accepted: boolean; messageId?: string; reason?: string; parts?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function normalizeBaileysPhone(phoneNumber: string) { return phoneNumber.replace(/\D/g, ""); }
// Phone-number chats are stored as the bare number; privacy-ID chats ("…@lid") keep the full JID so replies reach them.
export function waIdFromJid(jid: string) { return jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : jid; }
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

// Split a reply at blank lines into at most maxParts WhatsApp bubbles, the way a person sends several short messages.
export function splitIntoBubbles(body: string, maxParts = 3) {
  const parts = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= maxParts) return parts.length ? parts : [body];
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join("\n\n")];
}
// Roughly how long a person takes to type a message: a short pause plus ~35ms per character, capped.
export function typingDelayMs(text: string) { return Math.min(7000, Math.max(1500, 1000 + text.length * 35)); }
export function resetBaileysStatus(): Pick<BaileysStatus, "status" | "lastError"> { return { status: "disconnected", lastError: undefined }; }

class BaileysTransport {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private starting: Promise<void> | null = null;
  private status: BaileysConnectionStatus = "disconnected";
  private pairingCode: string | undefined;
  private qr: string | undefined;
  private qrLogged = false;
  private phoneNumber: string | undefined;
  private lastError: string | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly recentSends = new Map<string, number[]>();
  // One queue per chat: each client's messages are handled in order, but a reply being typed out to one client
  // no longer makes every other client wait behind it.
  private readonly chatQueues = new Map<string, Promise<void>>();
  // When "typing…" started showing in a chat, so the time the AI took counts toward the typing time.
  private readonly typingSince = new Map<string, number>();
  private readonly lastInboundKey = new Map<string, WAMessageKey>();
  // IDs of messages this process sent, so their echoes are never mistaken for the owner typing on the phone.
  private readonly sentIds = new Set<string>();
  // ponytail: in-memory buffer; texts still waiting when the process restarts are dropped, and only the last message ID in a burst is deduplicated.
  private readonly textBuffer = createDebouncer<{ parsed: ParsedWhatsAppMessage; remoteJid: string }>((waId, items) => {
    this.inChatOrder(waId, () => this.processBatch(items));
  }, INBOUND_TEXT_DEBOUNCE_MS);

  private inChatOrder(waId: string, task: () => Promise<void>) {
    const next = (this.chatQueues.get(waId) ?? Promise.resolve()).then(task).catch((error) => console.error("[Baileys] inbound processing failed", error));
    this.chatQueues.set(waId, next);
    void next.then(() => { if (this.chatQueues.get(waId) === next) this.chatQueues.delete(waId); });
  }

  async getStatus(): Promise<BaileysStatus> { return { status: this.status, phoneNumber: this.phoneNumber, pairingCode: this.pairingCode, qr: this.qr, lastError: this.lastError, updatedAt: new Date().toISOString(), hasSession: await hasBaileysSession() }; }

  // Whether a message could go out right now, without the database read getStatus() makes.
  isConnected() { return Boolean(this.socket) && this.status === "connected"; }

  async resetSession() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // Let go of the socket before closing it: its "close" event then belongs to no current connection and is ignored,
    // instead of scheduling a reconnect that would start a new login right after the owner cleared the session.
    const socket = this.socket;
    this.socket = null;
    socket?.end(undefined);
    this.qrLogged = false;
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
    const socket = makeWASocket({ auth, browser: Browsers.macOS("Chrome"), logger: pino({ level: "silent" }), markOnlineOnConnect: false, syncFullHistory: false });
    this.socket = socket;
    socket.ev.on("creds.update", () => saveBaileysCreds(auth.creds).catch((error) => console.error("[Baileys] credential persistence failed", error)));
    socket.ev.on("connection.update", (update) => this.handleConnection(update, auth, socket).catch((error) => console.error("[Baileys] connection update failed", error)));
    socket.ev.on("messages.upsert", ({ messages, type }) => { if (type === "notify") this.enqueueInbound(messages); });
    if (!auth.creds.registered) {
      this.status = "pairing";
    }
  }

  private async handleConnection(update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }, auth: Awaited<ReturnType<typeof createDatabaseAuthState>>, socket: ReturnType<typeof makeWASocket>) {
    // An update from a socket that was reset or replaced says nothing about the current connection.
    if (socket !== this.socket) return;
    if (update.qr && !auth.creds.registered) {
      this.status = "pairing";
      this.qr = update.qr;
      // WhatsApp replaces the code about every 20 seconds for as long as nobody scans it. One log entry per pairing
      // attempt says the same thing as one per code, without filling the event log.
      if (!this.qrLogged) {
        this.qrLogged = true;
        await recordEvent({ eventType: "baileys_qr_ready", title: "WhatsApp QR code ready", detail: "Scan the QR code to connect." });
      }
    }
    if (update.connection === "open") {
      this.status = "connected"; this.pairingCode = undefined; this.qr = undefined; this.qrLogged = false; this.reconnectAttempt = 0; this.lastError = undefined;
      this.phoneNumber = this.socket?.user?.id ? jidNormalizedUser(this.socket.user.id).split("@")[0] : undefined;
      await recordEvent({ eventType: "baileys_connected", title: "WhatsApp connected", detail: "The linked-device transport is connected." });
    }
    if (update.connection === "close") {
      const statusCode = baileysStatusCode(update.lastDisconnect?.error);
      this.socket = null;
      // A code from a closed connection can no longer be scanned; the next connection brings its own.
      this.qr = undefined;
      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.forbidden) {
        this.status = "reconnect_required"; this.lastError = `session_invalidated_${statusCode}`; this.pairingCode = undefined;
        await recordEvent({ eventType: "baileys_logged_out", severity: "error", title: "WhatsApp reconnect required", detail: "The linked-device session was invalidated. Reconnect WhatsApp from the dashboard." });
        await notifyOwner({ title: "WEBASI: WhatsApp reconnect required", content: "The Baileys linked-device session was logged out or invalidated. Open Connect WhatsApp and pair the number again." }).catch(() => false);
      } else {
        this.status = "reconnecting"; this.reconnectAttempt += 1;
        // "Connection replaced" means another process logged in with this same session: a second server instance, or a local dev
        // server pointed at the production database. Retrying at once makes the two knock each other offline in a loop
        // (79 reconnects in one day on 2026-09-29), so wait long enough for the other one to settle or shut down.
        const replaced = statusCode === DisconnectReason.connectionReplaced;
        const delay = replaced ? 60000 : Math.min(30000, 1000 * (2 ** Math.min(this.reconnectAttempt, 5)));
        clearTimeout(this.reconnectTimer); this.reconnectTimer = setTimeout(() => this.start().catch((error) => console.error("[Baileys] reconnect failed", error)), delay);
        await recordEvent({ eventType: "baileys_reconnecting", severity: "warning", title: "WhatsApp reconnecting", detail: `Connection closed (code ${statusCode || "unknown"}${replaced ? ": another process is using this WhatsApp session" : ""}); retry ${this.reconnectAttempt} in ${Math.round(delay / 1000)}s.` });
      }
    }
  }

  private enqueueInbound(messages: WAMessage[]) {
    for (const message of messages) this.inChatOrder(waIdFromJid(message.key.remoteJid ?? ""), () => this.handleInbound(message));
  }

  private async handleInbound(message: WAMessage) {
    try {
      const remoteJid = message.key.remoteJid ?? "";
      const waId = waIdFromJid(remoteJid);
      if (message.key.id && this.sentIds.has(message.key.id)) return; // our own reply echoing back
      if (this.isOwnChat(remoteJid)) return; // owner's "message yourself" chat, used for alerts
      if (shouldIgnoreBaileysMessage(remoteJid, Boolean(message.key.fromMe))) {
        if (message.key.fromMe && remoteJid && !remoteJid.endsWith("@g.us") && remoteJid !== "status@broadcast") {
          const echo = normalizeMessageContent(message.message);
          const ownerText = echo?.conversation ?? echo?.extendedTextMessage?.text ?? "";
          await pauseConversationByWaId(waId);
          if (ownerText) { await captureLearnedAnswer(waId, ownerText); await recordOwnerMessageByWaId(waId, ownerText); }
        }
        return;
      }
      // Unwraps disappearing, view-once and edited-message envelopes.
      const content = normalizeMessageContent(message.message);
      if (!content) return;
      if (message.key) this.lastInboundKey.set(remoteJid, message.key);
      const image = content.imageMessage;
      const text = content.conversation ?? content.extendedTextMessage?.text ?? image?.caption ?? undefined;
      const type = image ? "image" : text ? "text" : content.audioMessage ? "audio" : content.reactionMessage ? "reaction" : content.stickerMessage ? "sticker" : "unsupported";
      if (type === "reaction") return;
      const parsed: ParsedWhatsAppMessage = { id: message.key.id ?? `${waId}-${Date.now()}`, from: waId, waId, profileName: message.pushName ?? undefined, type, text: text ? { body: text } : undefined, image: image ? { id: message.key.id ?? undefined, caption: image.caption ?? undefined, mime_type: image.mimetype ?? undefined } : undefined };
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
    await processWhatsAppMessage(parsed, { sendText: (input) => this.sendText({ ...input, to: last.remoteJid }), onReplying: () => this.showTyping(last.remoteJid) });
  }

  // Blue ticks and "typing…" as soon as WEBASI starts on a reply, rather than only after the AI has finished writing it.
  private async showTyping(jid: string) {
    const socket = this.socket;
    if (!socket || this.status !== "connected") return;
    const key = this.lastInboundKey.get(jid);
    if (key) await socket.readMessages([key]).catch(() => undefined);
    await socket.sendPresenceUpdate("available").catch(() => undefined);
    await socket.presenceSubscribe(jid).catch(() => undefined);
    await socket.sendPresenceUpdate("composing", jid).catch(() => undefined);
    this.typingSince.set(jid, Date.now());
  }

  async startPairing() {
    this.qrLogged = false; // the owner asked for a code: log the next one
    await this.start();
    const deadline = Date.now() + 15000;
    while (!this.qr && Date.now() < deadline && this.status !== "reconnect_required") await sleep(250);
    if (!this.qr) throw new Error(this.lastError ?? "QR code is not ready yet; try again in a moment");
    return this.qr;
  }

  private isOwnChat(remoteJid: string) {
    const user = this.socket?.user;
    if (!user) return false;
    const own = [user.id, (user as { lid?: string }).lid].filter(Boolean).map((jid) => jidNormalizedUser(jid));
    return own.includes(jidNormalizedUser(remoteJid));
  }

  // Alerts go to the owner's own "message yourself" chat on the linked number.
  async sendToSelf(body: string): Promise<boolean> {
    if (!this.socket || this.status !== "connected" || !this.phoneNumber) return false;
    try {
      const sent = await this.socket.sendMessage(`${this.phoneNumber}@s.whatsapp.net`, { text: body });
      if (sent?.key?.id) this.sentIds.add(sent.key.id);
      return true;
    } catch (error) {
      console.error("[Baileys] owner alert failed", error instanceof Error ? error.message : error);
      return false;
    }
  }

  // humanize: mark the client's message read, show "typing…" for a realistic time, and send short bubbles.
  async sendText(input: { to: string; body: string; humanize?: boolean }): Promise<BaileysSendResult> {
    if (!this.socket || this.status !== "connected") return { accepted: false, reason: "baileys_not_connected" };
    const jid = input.to.includes("@") ? input.to : `${input.to}@s.whatsapp.net`;
    const parts = input.humanize ? splitIntoBubbles(input.body) : [input.body];
    const recent = (this.recentSends.get(jid) ?? []).filter((time) => Date.now() - time < 60000);
    if (recent.length + parts.length > ENV.baileysRateLimitPerMinute) return { accepted: false, reason: "baileys_rate_limited" };
    // "typing…" may already be showing since the AI started writing (showTyping); anything older than 30s has lapsed on the client's phone.
    const typingStarted = this.typingSince.get(jid);
    this.typingSince.delete(jid);
    const alreadyTypingSince = typingStarted && Date.now() - typingStarted < 30_000 ? typingStarted : undefined;
    try {
      const socket = this.socket;
      if (input.humanize && !alreadyTypingSince) {
        const key = this.lastInboundKey.get(jid);
        if (key) await socket.readMessages([key]).catch(() => undefined);
        await socket.sendPresenceUpdate("available").catch(() => undefined);
      }
      let messageId: string | undefined;
      for (const [index, part] of parts.entries()) {
        const last = recent.at(-1);
        if (!canSendBaileysMessage(recent, Date.now()) && last) await sleep(Math.max(0, 2500 - (Date.now() - last)));
        await socket.presenceSubscribe(jid).catch(() => undefined);
        await socket.sendPresenceUpdate("composing", jid);
        // The first bubble has been "typed" for as long as the AI took, so only the remainder is waited out.
        const alreadyTypedMs = index === 0 && alreadyTypingSince ? Date.now() - alreadyTypingSince : 0;
        await sleep(input.humanize ? Math.max(700, typingDelayMs(part) - alreadyTypedMs) : 500);
        await socket.sendPresenceUpdate("paused", jid);
        const sent = await socket.sendMessage(jid, { text: part });
        if (sent?.key?.id) { this.sentIds.add(sent.key.id); messageId ??= sent.key.id; }
        recent.push(Date.now());
      }
      if (input.humanize) await socket.sendPresenceUpdate("unavailable").catch(() => undefined);
      this.recentSends.set(jid, recent);
      while (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value as string);
      return { accepted: true, messageId, parts: parts.length };
    } catch (error) {
      console.error("[Baileys] sendMessage failed", error instanceof Error ? error.message : error);
      return { accepted: false, reason: `send_failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export const baileysTransport = new BaileysTransport();
export async function startBaileysTransport() { if (ENV.whatsappTransport === "baileys") await baileysTransport.start(); }
