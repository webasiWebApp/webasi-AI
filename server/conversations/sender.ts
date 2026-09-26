import { ENV } from "../_core/env";

export type SendTextInput = { to: string; body: string };
export type SendTextResult = { accepted: boolean; messageId?: string; reason?: string; parts?: number };

export function buildTextMessagePayload({ to, body }: SendTextInput) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body },
  };
}

export function outboundCapAllows(count: number, cap = ENV.whatsappMonthlyCap): boolean {
  return count < Math.floor(cap * 0.9);
}

export function createWhatsAppSender({
  fetchImpl = fetch,
  phoneNumberId = ENV.whatsappPhoneNumberId,
  accessToken = ENV.whatsappAccessToken,
  graphVersion = ENV.whatsappGraphVersion,
}: {
  fetchImpl?: typeof fetch;
  phoneNumberId?: string;
  accessToken?: string;
  graphVersion?: string;
} = {}) {
  return async function sendTextMessage(input: SendTextInput): Promise<SendTextResult> {
    if (!phoneNumberId || !accessToken) return { accepted: false, reason: "whatsapp_credentials_missing" };
    const response = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(buildTextMessagePayload(input)),
    });
    const data = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    if (!response.ok) return { accepted: false, reason: data.error?.message ?? `meta_http_${response.status}` };
    return { accepted: true, messageId: data.messages?.[0]?.id };
  };
}
