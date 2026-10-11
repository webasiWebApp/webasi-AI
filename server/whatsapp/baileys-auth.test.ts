import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../test-utils/fake-supabase";

// The encrypted WhatsApp session store against an in-memory table.
const holder = vi.hoisted(() => ({ db: null as unknown as import("../test-utils/fake-supabase").FakeSupabase }));
vi.mock("../_core/supabase", () => ({ getSupabaseServer: () => holder.db }));

let db: FakeSupabase;
let store: typeof import("./baileys-auth");
let env: typeof import("../_core/env").ENV;
const reads = () => db.calls.filter((call) => call.table === "baileys_auth_state" && call.action === "select").length;

beforeEach(async () => {
  vi.resetModules();
  db = holder.db = new FakeSupabase();
  env = (await import("../_core/env")).ENV;
  env.baileysSessionEncryptionKey = "test-encryption-key-of-at-least-32-chars";
  store = await import("./baileys-auth");
});

describe("WhatsApp session store", () => {
  it("stores the credentials encrypted and restores them exactly", async () => {
    const state = await store.createDatabaseAuthState();
    await store.saveBaileysCreds(state.creds);

    const payload: string = db.rows("baileys_auth_state")[0].payload;
    expect(payload).not.toContain("registrationId");
    expect(payload).not.toContain(Buffer.from(state.creds.noiseKey.private).toString("base64"));

    const restored = await store.createDatabaseAuthState();
    expect(restored.creds.registrationId).toBe(state.creds.registrationId);
    expect(Buffer.from(restored.creds.noiseKey.private).equals(Buffer.from(state.creds.noiseKey.private))).toBe(true);
  });

  it("cannot be read with a different key, or tampered with", async () => {
    const state = await store.createDatabaseAuthState();
    await store.saveBaileysCreds(state.creds);
    env.baileysSessionEncryptionKey = "another-encryption-key-of-32-characters!";
    await expect(store.createDatabaseAuthState()).rejects.toThrow();

    env.baileysSessionEncryptionKey = "test-encryption-key-of-at-least-32-chars";
    const row = db.rows("baileys_auth_state")[0];
    const bytes = Buffer.from(row.payload, "base64");
    bytes[bytes.length - 1] ^= 1;
    row.payload = bytes.toString("base64");
    await expect(store.createDatabaseAuthState()).rejects.toThrow();
  });

  it("refuses to store anything under a short key", async () => {
    env.baileysSessionEncryptionKey = "too-short";
    const state = await store.createDatabaseAuthState();
    await expect(store.saveBaileysCreds(state.creds)).rejects.toThrow(/at least 32 characters/);
    expect(db.rows("baileys_auth_state")).toHaveLength(0);
  });

  it("keeps, returns and removes Signal keys by type and id", async () => {
    const { keys } = await store.createDatabaseAuthState();
    const pair = (seed: number) => ({ public: Buffer.alloc(32, seed), private: Buffer.alloc(32, seed + 1) });
    await keys.set({ "pre-key": { "1": pair(1), "2": pair(2) } });
    const found = await keys.get("pre-key", ["1", "2", "3"]);
    expect(Object.keys(found).sort()).toEqual(["1", "2"]);
    expect(Buffer.from(found["2"].private).equals(Buffer.alloc(32, 3))).toBe(true);

    await keys.set({ "pre-key": { "1": null } });
    expect(Object.keys(await keys.get("pre-key", ["1", "2"]))).toEqual(["2"]);
  });

  it("answers repeated status checks from memory instead of reading the database each time", async () => {
    for (let poll = 0; poll < 5; poll++) expect(await store.hasBaileysSession()).toBe(false);
    expect(reads()).toBe(1);

    const state = await store.createDatabaseAuthState();
    await store.saveBaileysCreds(state.creds);
    const before = reads();
    expect(await store.hasBaileysSession()).toBe(true);
    await store.clearBaileysSession();
    expect(await store.hasBaileysSession()).toBe(false);
    expect(reads()).toBe(before);
    expect(db.rows("baileys_auth_state")).toHaveLength(0);
  });
});
