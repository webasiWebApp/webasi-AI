import { ENV } from "../_core/env";
import { createWhatsAppSender, type SendTextResult } from "../conversations/sender";
import { baileysTransport } from "./baileys";

// Sends one text over whichever WhatsApp transport is configured, and always answers with a result: a transport that
// throws (the Cloud API on a network error) is reported as a failed send instead of failing the caller.
export async function sendWhatsAppText(input: { to: string; body: string; humanize?: boolean }): Promise<SendTextResult> {
  try {
    return ENV.whatsappTransport === "baileys" ? await baileysTransport.sendText(input) : await createWhatsAppSender()(input);
  } catch (error) {
    return { accepted: false, reason: `send_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Whether a send could go out right now. The Cloud API has no connection to lose; it only needs its credentials.
export function canSendWhatsApp(): boolean {
  return ENV.whatsappTransport === "baileys" ? baileysTransport.isConnected() : Boolean(ENV.whatsappPhoneNumberId && ENV.whatsappAccessToken);
}
