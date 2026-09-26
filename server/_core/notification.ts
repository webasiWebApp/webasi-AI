import { ENV } from "./env";

export type NotificationPayload = {
  title: string;
  content: string;
};

// Owner alerts (handovers, slips, hot leads, connection problems).
// Uses the Forge notification service when configured, otherwise the owner's own
// "message yourself" WhatsApp chat on the linked number, so alerts work with zero extra setup.
export async function notifyOwner({ title, content }: NotificationPayload): Promise<boolean> {
  const text = `*${title.trim().slice(0, 200)}*\n${content.trim().slice(0, 3000)}`;
  if (ENV.forgeApiUrl && ENV.forgeApiKey) {
    try {
      const response = await fetch(new URL("webdevtoken.v1.WebDevService/SendNotification", ENV.forgeApiUrl.replace(/\/?$/, "/")), {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${ENV.forgeApiKey}`, "content-type": "application/json", "connect-protocol-version": "1" },
        body: JSON.stringify({ title, content }),
      });
      if (response.ok) return true;
      console.warn(`[Notification] Forge rejected alert (${response.status})`);
    } catch (error) {
      console.warn("[Notification] Forge unreachable", error instanceof Error ? error.message : error);
    }
  }
  // Dynamic import: the WhatsApp transport itself imports this module.
  const { baileysTransport } = await import("../whatsapp/baileys");
  const delivered = await baileysTransport.sendToSelf(text);
  if (!delivered) console.warn(`[Notification] Alert not delivered: ${title}`);
  return delivered;
}
