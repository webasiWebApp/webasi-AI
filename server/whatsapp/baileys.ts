import { DisconnectReason, Browsers, makeWASocket, type WAMessage } from "baileys";
import pino from "pino";
import { createDatabaseAuthState, saveBaileysCreds, hasBaileysSession, clearBaileysSession } from "./baileys-auth";
import { ENV } from "../_core/env";
import { processWhatsAppMessage } from "../conversations/processor";
import { pauseConversationByWaId, recordEvent } from "../module-db";
import { notifyOwner } from "../_core/notification";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";

export type BaileysConnectionStatus = "disconnected" | "pairing" | "connecting" | "connected" | "reconnecting" | "reconnect_required";
export type BaileysStatus = { status: BaileysConnectionStatus; phoneNumber?: string; pairingCode?: string; lastError?: string; updatedAt: string; hasSession: boolean };
export type BaileysSendResult = { accepted: boolean; messageId?: string; reason?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function normalizeBaileysPhone(phoneNumber: string) { return phoneNumber.replace(/\D/g, ""); }
export function shouldIgnoreBaileysMessage(remoteJid: string, fromMe: boolean) { return fromMe || !remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast"; }
export function canSendBaileysMessage(times: number[], now = Date.now(), maxPerMinute = ENV.baileysRateLimitPerMinute, minIntervalMs = 2500) { const recent = times.filter((time) => now - time < 60000); const last = recent.at(-1); return recent.length < maxPerMinute && (!last || now - last >= minIntervalMs); }
export function startupFailureStatus(error: unknown): Pick<BaileysStatus, "status" | "lastError"> { return { status: "reconnect_required", lastError: error instanceof Error ? error.message : "baileys_startup_failed" }; }

class BaileysTransport {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private starting: Promise<void> | null = null;
  private status: BaileysConnectionStatus = "disconnected";
  private pairingCode: string | undefined;
  private phoneNumber: string | undefined;
  private lastError: string | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly recentSends = new Map<string, number[]>();
  private inboundQueue = Promise.resolve();

  async getStatus(): Promise<BaileysStatus> { return { status: this.status, phoneNumber: this.phoneNumber, pairingCode: this.pairingCode, lastError: this.lastError, updatedAt: new Date().toISOString(), hasSession: await hasBaileysSession() }; }

  async start() {
    if (this.socket && ["connected", "connecting", "pairing", "reconnecting"].includes(this.status)) return;
    if (this.starting) return this.starting;
    this.starting = this.connect().catch(async (error) => {
      this.socket = null;
      const failure = startupFailureStatus(error);
      this.status = failure.status;
      this.lastError = failure.lastError;
      await recordEvent({ eventType: "baileys_startup_failed", severity: "error", title: "WhatsApp reconnect required", detail: this.lastError ?? "baileys_startup_failed" });
      await notifyOwner({ title: "WEBASI: WhatsApp reconnect required", content: "WEBASI could not restore the encrypted WhatsApp session. Reconnect from the dashboard; the stored session was not deleted automatically." }).catch(() => false);
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async connect() {
    this.status = this.reconnectAttempt ? "reconnecting" : "connecting";
    const auth = await createDatabaseAuthState();
    this.socket = makeWASocket({ auth, browser: Browsers.macOS("Chrome"), logger: pino({ level: "silent" }), markOnlineOnConnect: false, syncFullHistory: false });
    this.socket.ev.on("creds.update", (creds) => saveBaileysCreds(auth.creds).catch((error) => console.error("[Baileys] credential persistence failed", error)));
    this.socket.ev.on("connection.update", (update) => this.handleConnection(update, auth).catch((error) => console.error("[Baileys] connection update failed", error)));
    this.socket.ev.on("messages.upsert", ({ messages, type }) => { if (type === "notify") this.enqueueInbound(messages); });
  }

  private async handleConnection(update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }, auth: Awaited<ReturnType<typeof createDatabaseAuthState>>) {
    if (update.qr && !auth.creds.registered) {
      this.status = "pairing";
      if (this.phoneNumber && !this.pairingCode && this.socket) {
        try { this.pairingCode = await this.socket.requestPairingCode(this.phoneNumber); await recordEvent({ eventType: "baileys_pairing_code", title: "WhatsApp pairing code generated", detail: "A one-time pairing code is ready in Connect WhatsApp." }); }
        catch (error) { this.lastError = error instanceof Error ? error.message : "pairing_failed"; await recordEvent({ eventType: "baileys_pairing_failed", severity: "error", title: "WhatsApp pairing failed", detail: this.lastError }); }
      }
    }
    if (update.connection === "open") {
      this.status = "connected"; this.pairingCode = undefined; this.reconnectAttempt = 0; this.lastError = undefined;
      await recordEvent({ eventType: "baileys_connected", title: "WhatsApp connected", detail: "The linked-device transport is connected." });
    }
    if (update.connection === "close") {
      const statusCode = Number((update.lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode ?? 0);
      this.socket = null;
      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.forbidden) {
        this.status = "reconnect_required"; this.lastError = `session_invalidated_${statusCode}`; this.pairingCode = undefined;
        await clearBaileysSession();
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
    const remoteJid = message.key.remoteJid ?? "";
    if (shouldIgnoreBaileysMessage(remoteJid, Boolean(message.key.fromMe))) { if (message.key.fromMe && remoteJid) await pauseConversationByWaId(remoteJid.split("@")[0]); return; }
    const waId = remoteJid.split("@")[0];
    const content = message.message;
    if (!content) return;
    const image = content.imageMessage;
    const text = content.conversation ?? content.extendedTextMessage?.text ?? image?.caption;
    const type = image ? "image" : text ? "text" : content.audioMessage ? "audio" : "unsupported";
    const parsed: ParsedWhatsAppMessage = { id: message.key.id ?? `${waId}-${Date.now()}`, from: waId, waId, profileName: message.pushName ?? undefined, type, text: text ? { body: text } : undefined, image: image ? { id: message.key.id ?? undefined, caption: image.caption ?? undefined, mime_type: image.mimetype ?? undefined } : undefined };
    await recordEvent({ eventType: "baileys_message_received", title: "WhatsApp message received", detail: `${type} message from ${message.pushName ?? waId}.`, clientId: `baileys:${waId}` });
    await processWhatsAppMessage(parsed, { sendText: (input) => this.sendText(input) });
  }

  async requestPairingCode(phoneNumber: string) {
    const normalized = normalizeBaileysPhone(phoneNumber);
    if (!normalized || normalized.length < 8) throw new Error("Enter the phone number with country code and digits only");
    this.phoneNumber = normalized;
    await this.start();
    if (this.socket && this.status === "pairing" && !this.pairingCode) {
      try { this.pairingCode = await this.socket.requestPairingCode(normalized); }
      catch (error) { this.lastError = error instanceof Error ? error.message : "pairing_failed"; }
    }
    const deadline = Date.now() + 15000;
    while (!this.pairingCode && Date.now() < deadline && this.status !== "reconnect_required") await sleep(250);
    if (!this.pairingCode) throw new Error(this.lastError ?? "Pairing code is not ready yet; try again in a moment");
    return this.pairingCode;
  }

  async sendText(input: { to: string; body: string }): Promise<BaileysSendResult> {
    if (!this.socket || this.status !== "connected") return { accepted: false, reason: "baileys_not_connected" };
    const jid = input.to.includes("@") ? input.to : `${input.to}@s.whatsapp.net`;
    const now = Date.now(); const recent = (this.recentSends.get(jid) ?? []).filter((time) => now - time < 60000);
    if (!canSendBaileysMessage(recent, now)) {
      const last = recent.at(-1);
      if (recent.length >= ENV.baileysRateLimitPerMinute) return { accepted: false, reason: "baileys_rate_limited" };
      if (last) await sleep(Math.max(0, 2500 - (now - last)));
    }
    const sent = await this.socket.sendMessage(jid, { text: input.body });
    this.recentSends.set(jid, [...recent, Date.now()]);
    await recordEvent({ eventType: "baileys_message_sent", title: "WhatsApp message sent", detail: `Reply sent to ${jid}.`, clientId: `baileys:${input.to}` });
    return { accepted: true, messageId: sent?.key?.id ?? undefined };
  }
}

export const baileysTransport = new BaileysTransport();
export async function startBaileysTransport() { if (ENV.whatsappTransport === "baileys") await baileysTransport.start(); }
