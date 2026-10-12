import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The transport's connection and inbound handling, driven through a stand-in socket. No WhatsApp connection is made.
const world = vi.hoisted(() => ({
  sockets: [] as any[],
  creds: { registered: false } as Record<string, unknown>,
  recordEvent: vi.fn(async (_event: { eventType: string }) => undefined),
  notifyOwner: vi.fn(async () => true),
  process: vi.fn(async (_message: unknown, _deps: unknown) => ({ accepted: true, replied: false })),
  pause: vi.fn(async (_waId: string) => true),
  capture: vi.fn(async (_waId: string, _text: string) => false),
  recordOwner: vi.fn(async (_waId: string, _text: string) => true),
  clearSession: vi.fn(async () => undefined),
}));

vi.mock("baileys", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    DisconnectReason: { loggedOut: 401, forbidden: 403, badSession: 500, connectionReplaced: 440, timedOut: 408, restartRequired: 515, connectionClosed: 428 },
    Browsers: { macOS: (name: string) => ["Mac OS", name, "14"] },
    jidNormalizedUser: (jid: string) => jid.replace(/:\d+(?=@)/, ""),
    normalizeMessageContent: (content: unknown) => content,
    makeWASocket: () => {
      const ev = new EventEmitter();
      const socket = {
        ev, user: { id: "94779999999:5@s.whatsapp.net" },
        end: vi.fn(() => { ev.emit("connection.update", { connection: "close", lastDisconnect: { error: undefined } }); }),
        sendMessage: vi.fn(async () => ({ key: { id: `sent-${world.sockets.length}` } })),
        sendPresenceUpdate: vi.fn(async () => undefined), presenceSubscribe: vi.fn(async () => undefined), readMessages: vi.fn(async () => undefined),
      };
      world.sockets.push(socket);
      return socket;
    },
  };
});
vi.mock("./baileys-auth", () => ({ createDatabaseAuthState: async () => ({ creds: world.creds, keys: {} }), saveBaileysCreds: async () => undefined, hasBaileysSession: async () => false, clearBaileysSession: world.clearSession }));
vi.mock("../module-db", () => ({ recordEvent: world.recordEvent, pauseConversationByWaId: world.pause, captureLearnedAnswer: world.capture, recordOwnerMessageByWaId: world.recordOwner }));
vi.mock("../_core/notification", () => ({ notifyOwner: world.notifyOwner }));
vi.mock("../conversations/processor", () => ({ processWhatsAppMessage: world.process }));

let transport: typeof import("./baileys").baileysTransport;
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const update = (socket: any, value: Record<string, unknown>) => { socket.ev.emit("connection.update", value); return tick(); };
const closed = (statusCode: number) => ({ connection: "close", lastDisconnect: { error: { output: { statusCode } } } });
const eventTypes = () => world.recordEvent.mock.calls.map(([event]) => event.eventType);
const client = "94770001111@s.whatsapp.net";
const inbound = (id: string, text: string, key: Record<string, unknown> = {}) => ({ key: { remoteJid: client, id, fromMe: false, ...key }, pushName: "Nimal", message: { conversation: text } });
const deliver = (socket: any, messages: unknown[], type = "notify") => { socket.ev.emit("messages.upsert", { messages, type }); return tick(); };

async function connected() {
  await transport.start();
  const socket = world.sockets.at(-1);
  await update(socket, { connection: "open" });
  return socket;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  world.sockets.length = 0;
  world.creds = { registered: false };
  for (const mock of [world.recordEvent, world.notifyOwner, world.process, world.pause, world.capture, world.recordOwner, world.clearSession]) mock.mockClear();
  transport = (await import("./baileys")).baileysTransport;
});
afterEach(() => vi.useRealTimers());

describe("pairing", () => {
  it("logs the QR code once per pairing attempt, however often WhatsApp replaces it", async () => {
    await transport.start();
    const socket = world.sockets[0];
    for (const qr of ["code-1", "code-2", "code-3"]) await update(socket, { qr });
    expect(eventTypes().filter((type) => type === "baileys_qr_ready")).toHaveLength(1);
    expect(await transport.getStatus()).toMatchObject({ status: "pairing", qr: "code-3" });
  });

  it("drops the code of a connection that has closed", async () => {
    await transport.start();
    await update(world.sockets[0], { qr: "code-1" });
    await update(world.sockets[0], closed(408));
    expect((await transport.getStatus()).qr).toBeUndefined();
  });
});

describe("pairing that nobody completes", () => {
  const qrExpired = { connection: "close", lastDisconnect: { error: { message: "QR refs attempts ended", output: { statusCode: 408 } } } };

  it("stops asking for codes when none was scanned, until the owner asks again", async () => {
    await transport.start();
    await update(world.sockets[0], { qr: "code-1" });
    await update(world.sockets[0], qrExpired);
    expect((await transport.getStatus()).status).toBe("disconnected");
    expect(eventTypes()).toContain("baileys_qr_expired");
    await tick(300_000);
    expect(world.sockets).toHaveLength(1);

    const pairing = transport.startPairing();
    await tick();
    await update(world.sockets[1], { qr: "code-2" });
    await tick(300);
    expect(await pairing).toBe("code-2");
  });

  it("still reconnects after a scanned code asks for a restart, and after a lost connection", async () => {
    await transport.start();
    await update(world.sockets[0], closed(515));
    await tick(2000);
    expect(world.sockets).toHaveLength(2);
    await update(world.sockets[1], closed(408));
    await tick(4000);
    expect(world.sockets).toHaveLength(3);
  });
});

describe("connection", () => {
  it("reports connected once the socket opens", async () => {
    expect(transport.isConnected()).toBe(false);
    await connected();
    expect(transport.isConnected()).toBe(true);
    expect(await transport.getStatus()).toMatchObject({ status: "connected", phoneNumber: "94779999999" });
  });

  it("reconnects after an ordinary disconnect, with a short delay", async () => {
    const socket = await connected();
    await update(socket, closed(428));
    expect((await transport.getStatus()).status).toBe("reconnecting");
    await tick(1999);
    expect(world.sockets).toHaveLength(1);
    await tick(2);
    expect(world.sockets).toHaveLength(2);
  });

  it("waits a minute when another process took over the session, instead of fighting it", async () => {
    const socket = await connected();
    await update(socket, closed(440));
    await tick(59_000);
    expect(world.sockets).toHaveLength(1);
    await tick(1_100);
    expect(world.sockets).toHaveLength(2);
  });

  it("stops and alerts the owner when WhatsApp logs the device out", async () => {
    const socket = await connected();
    await update(socket, closed(401));
    expect(await transport.getStatus()).toMatchObject({ status: "reconnect_required", lastError: "session_invalidated_401" });
    expect(world.notifyOwner).toHaveBeenCalledOnce();
    await tick(120_000);
    expect(world.sockets).toHaveLength(1);
  });

  it("clearing the session does not start a new login on its own", async () => {
    const socket = await connected();
    await transport.resetSession();
    expect(socket.end).toHaveBeenCalledOnce();
    expect(world.clearSession).toHaveBeenCalledOnce();
    await tick(120_000);
    expect(world.sockets).toHaveLength(1);
    expect((await transport.getStatus()).status).toBe("disconnected");
  });

  it("ignores a late close from a socket that has already been replaced", async () => {
    const first = await connected();
    await update(first, closed(428));
    await tick(2000);
    const second = world.sockets[1];
    await update(second, { connection: "open" });
    await update(first, closed(428));
    expect(transport.isConnected()).toBe(true);
    await tick(120_000);
    expect(world.sockets).toHaveLength(2);
  });
});

describe("inbound messages", () => {
  it("answers a burst of texts from one client as a single turn", async () => {
    const socket = await connected();
    await deliver(socket, [inbound("m1", "hi")]);
    await tick(1000);
    await deliver(socket, [inbound("m2", "price?")]);
    await tick(3999);
    expect(world.process).not.toHaveBeenCalled();
    await tick(2);
    expect(world.process).toHaveBeenCalledOnce();
    expect(world.process.mock.calls[0][0]).toMatchObject({ id: "m2", waId: "94770001111", profileName: "Nimal", type: "text", text: { body: "hi\nprice?" } });
  });

  it("pauses the chat and keeps the text when the owner replies from the phone", async () => {
    const socket = await connected();
    await deliver(socket, [inbound("owner-1", "I'll call you at 5", { fromMe: true })]);
    expect(world.pause).toHaveBeenCalledWith("94770001111");
    expect(world.recordOwner).toHaveBeenCalledWith("94770001111", "I'll call you at 5");
    await tick(10_000);
    expect(world.process).not.toHaveBeenCalled();
  });

  it("ignores groups, status updates, the owner's own chat, reactions and history that is not a new message", async () => {
    const socket = await connected();
    await deliver(socket, [inbound("g1", "hello all", { remoteJid: "12345@g.us" }), inbound("s1", "status", { remoteJid: "status@broadcast" }), inbound("self", "note to self", { remoteJid: "94779999999@s.whatsapp.net", fromMe: true })]);
    await deliver(socket, [{ key: { remoteJid: client, id: "r1", fromMe: false }, message: { reactionMessage: { text: "👍" } } }]);
    await deliver(socket, [inbound("old", "from history")], "append");
    await tick(10_000);
    expect(world.process).not.toHaveBeenCalled();
    expect(world.pause).not.toHaveBeenCalled();
  });

  it("passes a photo on at once, after any texts that were still waiting", async () => {
    const socket = await connected();
    await deliver(socket, [inbound("m1", "here is the slip")]);
    await deliver(socket, [{ key: { remoteJid: client, id: "img-1", fromMe: false }, pushName: "Nimal", message: { imageMessage: { mimetype: "image/jpeg" } } }]);
    expect(world.process.mock.calls.map(([message]) => (message as { type: string }).type)).toEqual(["text", "image"]);
  });
});

describe("sending", () => {
  it("refuses to send while disconnected", async () => {
    expect(await transport.sendText({ to: "94770001111", body: "Hi" })).toEqual({ accepted: false, reason: "baileys_not_connected" });
  });

  it("sends a reply and does not mistake its own echo for the owner taking over", async () => {
    const socket = await connected();
    const sending = transport.sendText({ to: "94770001111", body: "Hello!" });
    await tick(1000);
    expect(await sending).toEqual({ accepted: true, messageId: "sent-1", parts: 1 });
    expect(socket.sendMessage).toHaveBeenCalledWith(client, { text: "Hello!" });
    await deliver(socket, [inbound("sent-1", "Hello!", { fromMe: true })]);
    expect(world.pause).not.toHaveBeenCalled();
  });

  it("holds each chat to the per-minute limit", async () => {
    const { ENV } = await import("../_core/env");
    ENV.baileysRateLimitPerMinute = 1;
    await connected();
    const first = transport.sendText({ to: "94770001111", body: "One" });
    await tick(1000);
    expect((await first).accepted).toBe(true);
    expect(await transport.sendText({ to: "94770001111", body: "Two" })).toEqual({ accepted: false, reason: "baileys_rate_limited" });
  });
});
