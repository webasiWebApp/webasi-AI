// Runs the work for one chat strictly in the order it arrived, while different chats proceed side by side. Each
// client's messages are therefore handled one at a time (a turn reads the conversation, then saves it), but a reply
// being typed out to one client does not make every other client wait behind it.
export function createChatQueue(onError: (error: unknown) => void = (error) => console.error("[WhatsApp] inbound processing failed", error)) {
  const queues = new Map<string, Promise<void>>();
  return function inChatOrder(chatId: string, task: () => unknown): Promise<void> {
    const next = (queues.get(chatId) ?? Promise.resolve()).then(task).then(() => undefined, onError);
    queues.set(chatId, next);
    // A finished queue is forgotten, so the map only holds chats with work in progress.
    void next.then(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
    return next;
  };
}
