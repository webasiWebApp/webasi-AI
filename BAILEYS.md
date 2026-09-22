# Baileys WhatsApp transport

WEBASI can use Baileys as an unofficial linked-device transport. Baileys connects through the same general mechanism as a WhatsApp Web companion device, so it does not require Meta Cloud API credentials. The owner links the number from the authenticated **Connect WhatsApp** page using the pairing code shown there.

Baileys is not Meta’s official API. WhatsApp may change the protocol, log out the linked device, restrict the number, or ban the account. WEBASI therefore keeps the existing ON/OFF switch, per-chat owner takeover pause, outbound rate limit, deduplication, one-to-one filtering, client-initiated-only behavior, usage caps, and event log. Do not use this transport for broadcasts or unsolicited messages. For a production-critical number, the official Meta Cloud API remains the safer choice.

Credentials and Signal keys are encrypted before being stored in the external database. The implementation does not depend on Render’s temporary filesystem. When the process wakes after sleep, it restores the database-backed session and reconnects. If WhatsApp reports a logged-out or invalid session, WEBASI stops retrying, alerts the owner, clears the invalid session, and shows **Reconnect required**.

The conversation engine, project snapshots, order state machine, usage guards, dashboard, and event log are transport-independent. To migrate back to Meta Cloud API later, set `WHATSAPP_TRANSPORT=cloud` and restore the Meta sender/webhook credentials. The business logic does not need to change.

## Required configuration

```env
WHATSAPP_TRANSPORT=baileys
BAILEYS_SESSION_ENCRYPTION_KEY=<long-random-secret>
BAILEYS_RATE_LIMIT_PER_MINUTE=8
```

`BAILEYS_PHONE_NUMBER` is optional because the owner can enter the number in the pairing page. If configured, it must contain digits only with the country code.
