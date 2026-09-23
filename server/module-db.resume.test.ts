import { beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ getDb }));

import { resumeConversation } from "./module-db";

describe("resumeConversation", () => {
  beforeEach(() => getDb.mockReset());

  it("clears the owner pause and returns success for the selected client", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    getDb.mockResolvedValue({ update });

    await expect(resumeConversation("client_live_test")).resolves.toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ isPaused: 0, state: "collecting", updatedAt: expect.any(Date) });
    expect(where).toHaveBeenCalledTimes(1);
  });
});
