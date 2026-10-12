import { describe, expect, it, vi } from "vitest";
import { createChatQueue } from "./chat-queue";

const deferred = () => { let release!: () => void; const done = new Promise<void>((resolve) => { release = resolve; }); return { done, release }; };
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("per-chat queue", () => {
  it("runs one chat's work in order and lets other chats run meanwhile", async () => {
    const inChatOrder = createChatQueue();
    const log: string[] = [];
    const first = deferred();
    void inChatOrder("a", async () => { log.push("a1 start"); await first.done; log.push("a1 end"); });
    void inChatOrder("a", async () => { log.push("a2"); });
    void inChatOrder("b", async () => { log.push("b1"); });
    await settle();
    expect(log).toEqual(["a1 start", "b1"]);
    first.release();
    await settle();
    expect(log).toEqual(["a1 start", "b1", "a1 end", "a2"]);
  });

  it("keeps going after a task fails, and reports the failure", async () => {
    const onError = vi.fn();
    const inChatOrder = createChatQueue(onError);
    const ran: string[] = [];
    void inChatOrder("a", async () => { throw new Error("boom"); });
    await inChatOrder("a", async () => { ran.push("next"); });
    expect(ran).toEqual(["next"]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
