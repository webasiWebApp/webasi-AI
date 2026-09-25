Here's the updated task list with your changes applied.

## Phase 1 — WhatsApp connection (Baileys)

- [ ] Set up Supabase project (free tier) — run `supabase/migrations/001_initial_schema.sql` in the hosted project and configure `SUPABASE_SERVICE_ROLE_KEY` in Render. The configured project currently reports `public.settings` missing, so the SQL migration has not been applied yet. This is now your only database and also stores Baileys session credentials (no local files, since Render has no persistent disk).
- [x] Build the Baileys auth state store backed by Supabase. Credentials are encrypted before storage in `baileys_auth_state`.
- [x] Build the "Connect WhatsApp" pairing page (QR/pairing code) — no login needed, just open it directly since there's no auth system.
- [ ] Link your number, confirm a message round-trip.
- [x] Handle reconnects across Render's sleep/wake cycle; detect logged-out state and alert by email.
- [x] Deduplicate messages by ID; ignore group chats and the owner's own outgoing messages (treat as "owner took over this chat").
- [ ] Debounce rapid consecutive client messages into one turn.

## Phase 2 — Backend and dashboard skeleton

- [x] Scaffold Node.js/TypeScript backend.
- [x] Define Supabase tables: `projects`, `conversations`, `messages`, `settings`, `event_log`, and encrypted `baileys_auth_state`. (No `users` or `orders` tables are in the Supabase migration.)
- [x] Build the ON/OFF switch runtime path. Settings, projects, conversations, usage counters, events, and takeover state now prefer Supabase when configured; apply the hosted migration before using production data.
- [x] Build `/health` and `/healthz` endpoints. Connect cron-job.org after Render deployment.
- [x] Dashboard has no login — anyone with the link can open it. *(Flag: since there's no auth, treat the dashboard URL itself as the secret — don't share or index it, and know that anyone with the link can flip the switch or edit the knowledge base.)*

## Phase 3 — AI conversation engine

- [x] Get a Gemini API key from Google AI Studio and load it through `GEMINI_API_KEY`.
- [x] Wire up the Gemini call with structured JSON output: reply text, extracted lead info, intent/interest signals, objection type, and owner handover fields.
- [x] Build strict grounding: the AI answers **only** from the active project's trained knowledge base. Anything outside it → short escalation reply + handover.
- [x] Build basic objection handling within trained data only.
- [x] Build prompt-injection resistance — client text is always data, never instructions.
- [x] Build the handover trigger and owner notification path.
- [ ] Collect 30–50 real Singlish/English client messages and test the engine against them; tune prompts.

## Phase 4 — Lead qualification (from your notes)

- [x] Define a small set of qualifying questions per project (budget, timeline, business type, what they actually need) — asked naturally, not as a form.
- [ ] Build an intent/fit score in the AI's structured output (e.g. high/medium/low) based on how the client answers — so low-fit "just browsing" chats don't consume your attention the same way as serious ones.
- [ ] Surface this score on the Conversations list so you can see at a glance which chats are worth jumping into first.
- [ ] Make the first response instant (this is already true by design — Baileys replies the moment a message arrives, no queue).

## Phase 5 — Project (knowledge base) management

- [x] Build the Projects list page.
- [x] Only one project can be Active at a time; activating one deactivates the other automatically.
- [x] Build the training interview checklist and approval flow, including deposit and escalation guidance.
- [x] Build the checklist progress view and the "generate summary → owner approves or corrects" step.
- [x] Build Test Chat — a sandbox to try the trained project before activating it, sends nothing to WhatsApp.

## Phase 6 — Insights (knowledge base growth loop)

- [ ] Log every message with tags (topic, intent score, handed over or not).
- [x] Build on-demand analysis: common questions, questions that triggered handover, common objections, where chats stall.
- [ ] Build "Add to knowledge base" / "Dismiss" actions so gaps you spot get folded back into the trained project — this is how the bot's answers get more exact over time, per your note.

## Phase 7 — Guardrails (keeps you at $0)

- [x] Count outbound WhatsApp messages per month; warn/stop before hitting risky volume.
- [x] Count Gemini requests per day against the free limit; degrade gracefully when hit.
- [x] Build the Event log (connection issues, errors, handovers) without a login-gated audit trail.

## Phase 8 — Test and go live

- [ ] Run through: normal qualifying conversation, Singlish conversation, price objection, off-topic question → handover, "are you a bot?", prompt-injection attempt, mid-chat OFF, owner takeover from phone, duplicate message delivery, Render cold start, Gemini rate limit hit.
- [ ] Run one week in shadow mode (AI drafts replies without sending) to sanity-check tone and grounding against real messages.
- [ ] Go live, watch the Event log and handover emails closely for the first few days, feed anything it got wrong back into the knowledge base via Insights.

