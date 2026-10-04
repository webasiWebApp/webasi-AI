export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

// failFast: give up on the first rate limit or timeout instead of waiting it out, so the caller can try another provider.
// timeoutMs: for work no client is waiting on (a long generation), in place of LLM_REQUEST_TIMEOUT_MS.
export type InvokeOptions = { failFast?: boolean; timeoutMs?: number };

// One attempt may take this long before it is abandoned; a hung request must never stall a client's chat.
export const LLM_REQUEST_TIMEOUT_MS = 20_000;

// Sliding one-minute window. With wait=false a full window is reported (false) instead of slept through.
export function createMinuteLimiter(maxPerMinute: number) {
  const timestamps: number[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const prune = () => { const now = Date.now(); while (timestamps.length > 0 && now - timestamps[0] > 60_000) timestamps.shift(); };
  return function acquire({ wait = true }: { wait?: boolean } = {}): Promise<boolean> {
    const turn = queue.then(async () => {
      prune();
      if (timestamps.length >= maxPerMinute) {
        if (!wait) return false;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 60_000 - (Date.now() - timestamps[0]))));
        prune();
      }
      timestamps.push(Date.now());
      return true;
    });
    queue = turn.catch(() => undefined);
    return turn;
  };
}
