Here's the updated task list with your changes applied.

## Phase 1 — WhatsApp connection (Baileys)

- [x] Set up Supabase project (free tier) — run migrations `001` to `004` from `supabase/migrations/` in order, and set `SUPABASE_SERVICE_ROLE_KEY` in Render.
- [x] Build the Baileys auth state store backed by Supabase. Credentials are encrypted before storage in `baileys_auth_state`.
- [x] Build the "Connect WhatsApp" pairing page (QR code) — no login needed.
- [ ] **(owner)** Link your number, confirm a message round-trip.
- [x] Handle reconnects across Render's sleep/wake cycle; detect logged-out state and alert by email.
- [x] Deduplicate messages by ID; ignore group chats and the owner's own outgoing messages (treat as "owner took over this chat").
- [x] Debounce rapid consecutive client messages into one turn (4 s quiet window per client, in `server/whatsapp/baileys.ts`).

## Phase 2 — Backend and dashboard skeleton

- [x] Scaffold Node.js/TypeScript backend.
- [x] Define Supabase tables: `projects`, `conversations`, `messages`, `settings`, `event_log`, and encrypted `baileys_auth_state`. `orders` is added by `002_orders_and_lockdown.sql`; there is no `users` table because the dashboard has no login.
- [x] Build the ON/OFF switch runtime path. Settings, projects, conversations, usage counters, events, and takeover state now prefer Supabase when configured; apply the hosted migration before using production data.
- [x] Build `/health` and `/healthz` endpoints. Connect cron-job.org after Render deployment.
- [x] Dashboard has no login by choice — anyone with the link can open it, so treat the dashboard URL as the secret (don't share or index it). `/health` exposes no QR code or phone number.

## Phase 3 — AI conversation engine

- [x] Get a Gemini API key from Google AI Studio and load it through `GEMINI_API_KEY`.
- [x] Wire up the Gemini call with structured JSON output: reply text, extracted lead info, intent/interest signals, objection type, and owner handover fields.
- [x] Build strict grounding: the AI answers **only** from the active project's trained knowledge base. Anything outside it → short escalation reply + handover.
- [x] Build basic objection handling within trained data only.
- [x] Build prompt-injection resistance — client text is always data, never instructions.
- [x] Build the handover trigger and owner notification path.
- [x] Test the engine against 40 English/Singlish/Sinhala client messages: `pnpm eval` runs them against the real AI and flags missed handovers, identity slips, bullet lists and over-long replies. **(owner)** Add your own real messages to `scripts/eval-engine.ts` as they come in and re-run after prompt changes.

## Phase 4 — Lead qualification (from your notes)

- [x] Define a small set of qualifying questions per project (budget, timeline, business type, what they actually need) — asked naturally, not as a form.
- [x] Build an intent/fit score in the AI's structured output (e.g. high/medium/low) based on how the client answers — so low-fit "just browsing" chats don't consume your attention the same way as serious ones.
- [x] Surface this score on the Conversations list so you can see at a glance which chats are worth jumping into first.
- [x] First response is fast but human-paced: texts sent within 4 s are answered together, the client sees their message read, then "typing…" for a time based on reply length (1.5–7 s), and longer replies arrive as up to 3 short messages.

## Phase 5 — Project (knowledge base) management

- [x] Build the Projects list page.
- [x] Only one project can be Active at a time; activating one deactivates the other automatically.
- [x] Build the training interview checklist and approval flow, including deposit and escalation guidance.
- [x] Build the checklist progress view and the "generate summary → owner approves or corrects" step.
- [x] Build Test Chat — a sandbox to try the trained project before activating it, sends nothing to WhatsApp.

## Phase 6 — Insights (knowledge base growth loop)

- [x] Log every message with tags (topic, intent score, handed over or not) in the Supabase `messages` table.
- [x] Build on-demand analysis: common questions, questions that triggered handover, common objections, where chats stall.
- [x] Build "Approve" / "Dismiss" actions on Insights. Approving marks the suggestion; apply it by editing the project training (suggestions are advice, not facts, so they are never injected into the bot automatically).

## Phase 7 — Guardrails (keeps you at $0)

- [x] Count outbound WhatsApp messages per month; warn/stop before hitting risky volume.
- [x] Count Gemini requests per day against the free limit; degrade gracefully when hit.
- [x] Build the Event log (connection issues, errors, handovers, hot leads, frustrated clients, knowledge added).

## Phase 8 — Test and go live

- [ ] **(owner, live)** Run through: normal qualifying conversation, Singlish conversation, price objection, off-topic question → handover, "are you a bot?", prompt-injection attempt, mid-chat OFF, owner takeover from phone, duplicate message delivery, Render cold start, Gemini rate limit hit. *(Automated coverage for OFF, takeover, duplicates, AI rate limit, frustrated client, hot lead, voice notes and missing project: `server/conversations/processor.scenarios.test.ts`.)*
- [ ] **(owner, live)** Run one week in shadow mode (AI drafts replies without sending) to sanity-check tone and grounding against real messages.
- [ ] **(owner, live)** Go live and watch the Event log and the alerts in your WhatsApp "message yourself" chat for the first few days; approve Learned answers on Insights so the knowledge base grows.

## Phase 9 — Natural conversations and client behaviour

- [x] Owner alerts (handover, slip, hot lead, frustrated client, voice note, AI failure, WhatsApp logout) are delivered to the owner's own WhatsApp "message yourself" chat — no email service needed.
- [x] Replies read like a person texting: mirrors the client's language and formality, one question at a time, no scripted greetings, uses the client's name occasionally, knows the Sri Lankan time of day, welcomes returning clients back. Still says it is an AI assistant if sincerely asked.
- [x] Client memory: a running note of who the client is and what they want is kept per chat and fed back on every turn, so the bot doesn't re-ask things beyond the last 20 messages.
- [x] Behaviour detection on every turn: lead fit (high/medium/low), mood (positive/neutral/confused/frustrated), main objection (price, timeline, trust, scope, competitor, thinking it over) and language — shown in a Client insight panel in Conversations and Test Chat.
- [x] Frustrated clients are handed to the owner automatically; a lead turning hot alerts the owner once.
- [x] Knowledge base growth: when the owner answers a handed-over question (from the dashboard or the phone), it becomes a "Learned answer" on Insights; editing and approving it appends it to the active project's FAQs, which the bot uses immediately. FAQ and escalation-rule training answers now reach the bot.
- [x] Prices, percentages and timelines in approved FAQs (and the computed deposit) pass the grounding check; invented numbers are still blocked.
- [x] The chat leads to a meeting: after answering, WEBASI checks once whether the price works for the client, then offers a short call or online meeting and asks for a day and time (also when the price is a problem, or when the facts state no price). When the client names a time the owner is alerted with the time, how they want to meet and how they took the price, the chat is handed over, and the weekly summary counts the meetings. WEBASI never confirms the meeting itself. It no longer works through the order-detail checklist; the brief-to-deposit step still runs if a client volunteers every detail.
- [x] Instant answers: approving the training has the AI write the questions clients are likely to ask, each with a ready answer and several phrasings, from the approved knowledge (one AI request). A client question that clearly matches one of these, or one of the owner's own FAQs, is answered from the list without an AI request. Shown, regenerated and pruned from the Training page; generated answers stop being used when the project knowledge changes until they are regenerated. English only unless `FAQ_ENGLISH_FOR_SINGLISH=true`.

## Phase 10 — Follow-ups and weekly summary

- [x] Follow-ups: one friendly nudge when a client goes quiet after WEBASI's last message — 6–23 h after their last message (inside WhatsApp's 24 h window), 9am–8pm Sri Lanka time, only while collecting details or awaiting the deposit, never for low-fit leads, paused or handed-over chats. Written by the AI in the client's language and grounding-checked, with a fixed fallback. Drafts only in shadow mode. Switch in Settings.
- [x] Weekly summary: every Monday 9am to the owner's WhatsApp — chats, hot leads, handovers, orders and confirmed deposits, slips to verify, top objections, follow-ups sent, knowledge added, learned answers waiting, WhatsApp usage. Preview and "Send now" on Insights. Switch in Settings.
