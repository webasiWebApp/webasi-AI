# WEBASI AI - System Overview

An AI WhatsApp sales assistant with an owner dashboard, plus a client pipeline that runs the owner's whole workflow from the first chat to project close: meetings, quotations, contracts, invoices, receipts, tasks, finance and renewals.

> Sources: the repository itself and the graphify output in `graphify-out/` (built 2026-09-26; out of date, so where the two disagree this document follows the code). First written 2026-10-28; updated the same day for the pipeline module (section 5).

---

## 1. Technical background

### Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.9, ESM (`"type": "module"`), Node 22 |
| Package manager | pnpm 10 |
| Frontend | React 19, Vite 7, Tailwind CSS 4, shadcn/Radix primitives, wouter (routing), TanStack Query, sonner (toasts), lucide icons |
| API | tRPC 11 on Express 4, superjson, zod 4 validation |
| Database | Supabase (Postgres) through `@supabase/supabase-js` and SQL migrations |
| WhatsApp | Baileys `7.0.0-rc14` (unofficial linked-device) by default; Meta Cloud API webhook as an alternative |
| LLM | Gemini (default) or Groq, chosen at runtime |
| PDF | `pdfkit` (pure JavaScript, no headless browser), Open Sans bundled in `server/documents/fonts` |
| Logging | pino (Baileys only) |
| Tests | Vitest 4, in-memory fake Supabase, PGlite (real Postgres in-process) for SQL, jsdom + Testing Library for the dashboard |
| CI | GitHub Actions (`ci.yml`: type check, tests, build; `uptime.yml`: keep-alive ping) |
| Hosting | Vercel (`vercel.json`, `api/index.ts`) and Render |

### Architecture

```
 WhatsApp client
      |
      v
 +-----------------+      +---------------------------+
 | Baileys         |  or  | Meta Cloud webhook        |   WHATSAPP_TRANSPORT = baileys | cloud
 | server/whatsapp |      | server/webhooks/whatsapp  |
 +--------+--------+      +-------------+-------------+
          +--------------+--------------+
                         v
              conversations/processor.ts          claim message (dedupe), caps, state machine
                 |            |          |
                 |            |          +--> sender.ts / whatsapp/outbound.ts  (rate limit, 24h window, hours)
                 |            +-------------> faq-cache.ts / faq-generator.ts  (instant answers, no AI call)
                 v
              conversations/engine.ts  ---->  _core/llm.ts --> gemini.ts | groq.ts
                 |
                 v
              db.ts + module-db.ts + data/*   ---->  Supabase (Postgres)
                 ^                                         ^
                 |                                         | RPCs, constraints, triggers (the money rules)
   routers.ts + routers.pipeline.ts (tRPC)  <----  /api/trpc  <----  React dashboard (client/)
   documents/routes.ts (PDF, CSV downloads)  <---- /api/documents, /api/finance
   automation.ts: follow-ups, handover reminders, weekly summary, retention,
                  pipeline reminders (pipeline-reminders.ts), calendar sync (integrations/meeting-sync.ts)
```

### Message flow (one inbound message)
1. **Transport** receives the message. Baileys sessions are encrypted and stored in `baileys_auth_state`. A per-chat queue keeps one chat's messages in order.
2. **`processWhatsAppMessage()`** claims the message ID in `messages`; a unique-key violation means a duplicate. Voice notes get a fixed "please type it" reply.
3. **Owner takeover and shadow mode.** A paused or handed-over chat stays silent. In shadow mode replies are saved as drafts for the owner.
4. **Instant answers** from the FAQ cache, without an AI request.
5. **Engine** builds a turn and calls the LLM; the reply is structured (intent, sentiment, objection, next order state).
6. **Guards**: monthly outbound cap, daily AI cap, Baileys rate limit, 24-hour reply window. Usage is counted atomically through `increment_usage_counter`.
7. **Persist and notify.** Messages, order state, events and knowledge gaps are written; the owner is notified on handover.

### Order state machine (`shared/webasi.ts`)
`new` → `collecting` → `brief_complete` → `awaiting_deposit` → `slip_received` → `confirmed_by_owner`; side states `needs_owner`, `paused`, `abandoned`, `cancelled`. This is the AI assistant's order flow and is separate from the pipeline's Job stages below.

### Background jobs (`server/automation.ts`)
Run every 15 minutes, only when not on Vercel:
- **Pipeline reminders** (section 5): quotation with no answer, unpaid balance after delivery, renewals due.
- **Calendar sync**: pending and failed Google Calendar syncs.
- **Follow-ups**: a nudge 6 to 23 hours after a client's last message.
- **Handover reminders**, **weekly summary** (Monday 09:00), **retention** (when configured).
- Messages to the owner go out 09:00 to 20:00 Asia/Colombo only.

### Security (`server/_core/app.ts`, `pin-lock.ts`, `http-guards.ts`)
- **PIN lock.** `DASHBOARD_PIN` guards the dashboard. `POST /api/auth/login` checks the PIN in constant time and sets a signed (HMAC with `JWT_SECRET`), `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie valid for 7 days. `/api/trpc/*` and every document route need that cookie (401 otherwise). Wrong PINs: 5 free tries per address, then a lockout that doubles each further miss (1 minute up to 1 hour). Changing the PIN signs everyone out. Changes from another site are refused (403).
- Production with no `DASHBOARD_PIN` (or no `JWT_SECRET`) answers **503** to everything except `/health`, `/healthz`, `/api/keepalive` and the WhatsApp webhook. Development stays open with a console warning.
- `DASHBOARD_PASSWORD` (HTTP Basic) is **deprecated and ignored**; a leftover value logs a warning at startup.
- Content Security Policy (production), `X-Frame-Options: DENY`, `nosniff`, HSTS over HTTPS, `noindex`, restrictive `Permissions-Policy`.
- Rate limits on `/api/trpc`: 240 per minute per address, and 20 per minute for calls that spend AI requests. JSON body limit 100 KB.
- A final error handler logs the method, path and status of a failed request, never the error's message (body-parser errors can quote the request).

### Database (Supabase migrations in `supabase/migrations/`)

| Migration | Adds |
|---|---|
| `001_initial_schema.sql` | `settings`, `projects`, `conversations`, `messages`, `event_log`, `baileys_auth_state`, `usage_counters`, `training_sessions`, `insights` |
| `002_orders_and_lockdown.sql` | `orders` and access lockdown |
| `003_client_behaviour.sql`, `004_followups_and_weekly_summary.sql` | client behaviour fields, follow-ups, weekly summary |
| `20261002_increment_usage_rpc.sql` | `increment_usage_counter()` |
| `20261004_knowledge_gaps.sql` | `knowledge_gaps` |
| `20261011_atomic_writes_and_indexes.sql` | `append_conversation_message()`, `activate_project()`, indexes |
| `20261029_jobs_documents_ledger.sql` | `jobs`, `meetings`, `task_templates`, `job_tasks`, `documents`, `ledger_entries`, new `settings` columns, the stage and money rules, and the functions in section 5 |
| `20261030_renewals_reminders.sql` | `renewals`, `reminder_log`, `mark_delivered()`, `claim_reminder()`, `finish_reminder()` |

The server keeps working when a migration has not been applied (the AI assistant never touches the new tables; the background jobs skip quietly until they exist).

### Configuration (environment variables, `server/_core/env.ts`; a template is in `.env.example`)
- **Core**: `NODE_ENV`, `PORT`, `JWT_SECRET` (required in production: signs the session cookie), `DASHBOARD_PIN` (required in production)
- **Database**: `SUPABASE_URL` (or `VITE_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`
- **AI**: `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_RPM_LIMIT`, `GEMINI_DAILY_CAP`, `GROQ_API_KEY`, `WEBASI_ENABLED`, `WEBASI_LLM_MODEL`, `FAQ_ENGLISH_FOR_SINGLISH`
- **WhatsApp**: `WHATSAPP_TRANSPORT`, `BAILEYS_PHONE_NUMBER`, `BAILEYS_SESSION_ENCRYPTION_KEY`, `BAILEYS_RATE_LIMIT_PER_MINUTE`, `WHATSAPP_MONTHLY_CAP`, and for the cloud transport `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_OWNER_WA_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_GRAPH_VERSION`
- **Google Calendar (optional)**: `GOOGLE_SERVICE_ACCOUNT_JSON` (base64 of the key file), `GOOGLE_CALENDAR_ID`
- **Limits and retention**: `API_RATE_LIMIT_PER_MINUTE`, `AI_RATE_LIMIT_PER_MINUTE`, `HANDOVER_REMINDER_HOURS`, `EVENT_LOG_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS`

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | `tsx watch` the server, with Vite middleware for the client |
| `pnpm build` | Vite build to `dist/public`, then esbuild bundles the server to `dist/index.js` |
| `pnpm start` | Run the production bundle (from the project root: it finds `server/documents` there) |
| `pnpm check` | `tsc --noEmit` |
| `pnpm test` | `vitest run`: a `unit` project (parallel) and a `database` project (PGlite files, one at a time) |
| `pnpm pdf:preview <dir>` | Write one sample of every PDF to look at while changing the layout |
| `pnpm eval` | Offline evaluation of the AI engine (spends real AI requests) |

### Known risks
- Baileys is **not an official WhatsApp API**; the number can be logged out or banned. `BAILEYS.md` recommends the Meta Cloud API for a production-critical number.
- Background jobs and the Baileys connection do not run on Vercel (serverless), so those need a long-running host such as Render. Google Calendar sync still runs right after each save there, but its retries and the owner reminders do not.
- Free-tier LLM limits are tight: Gemini 5 requests per minute, Groq 8k tokens per minute.
- The PDF font (Open Sans) covers Latin, Greek and Cyrillic. Sinhala or Tamil letters in a document print as "?".

---

## 2. File system

```
webasi-AI/
├─ api/index.ts                    Vercel serverless entry; re-exports the Express app
├─ client/
│  └─ src/
│     ├─ main.tsx, App.tsx         providers; App shows the lock screen until the PIN is entered
│     ├─ pages/                    one file per dashboard page (see Sitemap); Home.tsx is the small router
│     │  ├─ TodayPage, PipelinePage, JobPage, CalendarPage, FinancePage     (pipeline module)
│     │  └─ job/                   the Job page's tabs: Meetings, Documents, Tasks, Money, Renewals
│     ├─ components/
│     │  ├─ DashboardLayout.tsx, LockScreen.tsx, dashboard/shared.tsx, ui/
│     │  └─ pipeline/              kit.tsx (inputs, modal, stat), MeetingForm.tsx, PipelineSettings.tsx
│     ├─ hooks/                    useDashboardLock, usePipelineSettings, ...
│     └─ pipeline.ui.test.tsx      the main path driven through the pages (jsdom)
├─ server/
│  ├─ _core/                       infrastructure
│  │  ├─ index.ts, app.ts, env.ts, context.ts, trpc.ts
│  │  ├─ pin-lock.ts               the PIN screen's server side
│  │  ├─ http-guards.ts, rate-limit.ts, notification.ts, supabase.ts, vite.ts
│  │  └─ llm.ts, gemini.ts, groq.ts
│  ├─ conversations/               the AI assistant: processor, engine, FAQ cache, sender
│  ├─ whatsapp/, webhooks/         Baileys transport and the Meta Cloud webhook
│  ├─ data/                        data layer, one module per area
│  │  ├─ settings, projects, training, conversations, orders, events, insights, drafts, retention, stats   (assistant)
│  │  └─ jobs, ledger, documents, meetings, tasks, renewals, reminders, finance, today, errors            (pipeline)
│  ├─ documents/                   PDF generation
│  │  ├─ brand.ts, builders.ts     page furniture and one builder per document
│  │  ├─ render.ts, routes.ts      build by id; the download routes and the credentials route
│  │  └─ fonts/, assets/           Open Sans (OFL) and the logo, bundled in the repo
│  ├─ integrations/                google-calendar.ts (REST, no SDK), meeting-sync.ts
│  ├─ routers.ts, routers.pipeline.ts   tRPC appRouter and the pipeline routers
│  ├─ automation.ts, pipeline-reminders.ts
│  ├─ db.ts, module-db.ts          conversation helpers; module-db re-exports ./data/* (assistant modules)
│  ├─ test-utils/                  fake-supabase.ts (in-memory), pg-supabase.ts (PGlite-backed Supabase stand-in)
│  └─ *.test.ts                    tests next to the code they cover; pipeline.*.test.ts use a real Postgres
├─ shared/                         webasi.ts (order state machine), jobs.ts (stage machine), finance.ts, money.ts,
│                                  time.ts, documents.ts (kinds, payloads, default wording), reminders.ts, tests
├─ supabase/migrations/            SQL, 9 files
├─ scripts/                        eval-engine.ts, preview-pdfs.ts
├─ docs/                           reference/ (the inputs the pipeline was built from), OWNER-GUIDE.md
├─ .github/workflows/              ci.yml, uptime.yml
├─ BAILEYS.md, task.md, .env.example, vercel.json, vite.config.ts, vitest.config.ts, tsconfig.json, package.json
└─ graphify-out/                   knowledge graph (generated, out of date)
```

The pipeline's data modules are imported directly (for example `./data/jobs`); only the assistant's modules go through `module-db.ts`.

---

## 3. Sitemap

### Dashboard pages (client)

| Path | Sidebar | File | Purpose |
|---|---|---|---|
| (lock screen) | | `LockScreen.tsx` | PIN entry; shown until the session cookie exists |
| `/` | Home | `HomePage.tsx` | Overview of the assistant |
| `/today` | Today | `TodayPage.tsx` | Meetings (7 days), tasks due or overdue, the next task of each active or delivered job, money to chase, quotations unanswered, renewals due |
| `/pipeline` | Pipeline | `PipelinePage.tsx` | One column per stage with job cards; Create job. `?new=<client id>` opens the form pre-filled from a conversation |
| `/jobs/:id` | (Pipeline) | `JobPage.tsx` | Tabs: Overview, Meetings, Documents, Tasks, Money, Renewals, Notes. `?tab=Money` opens a tab |
| `/calendar` | Calendar | `CalendarPage.tsx` | Hand-built month grid, day agenda, add, edit, cancel, mark done, retry sync |
| `/finance` | Finance | `FinancePage.tsx` | Month or all-time income, costs, company profit, receivables, per-job table, monthly trend, ledger, CSV export |
| `/projects`, `/training`, `/test-chat` | Projects, Training, Test Chat | | The AI assistant's training snapshots (unrelated to Jobs) |
| `/conversations`, `/drafts`, `/connect-whatsapp`, `/orders`, `/insights`, `/events` | | | The AI assistant's inbox, drafts, pairing, orders, insights, audit trail |
| `/settings` | Settings | `SettingsPage.tsx` | The assistant's settings, then **Business documents**, **Task template**, **Reminders and categories**, and the "Template review needed" notice |

`NotFound.tsx` exists but is not wired in; unknown paths show the landing page.

### HTTP endpoints (server)

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/keepalive`, `/healthz` | open | Uptime pings |
| `GET /health` | open | Supabase and WhatsApp state; 503 when down |
| `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout` | open | The lock screen's calls |
| `/api/trpc/*` | PIN cookie, rate limited | The tRPC API below |
| `GET /api/documents/:id/pdf` | PIN cookie | A stored document as a PDF attachment (`no-store`) |
| `POST /api/documents/credentials/pdf` | PIN cookie | Credentials & Access sheet built in memory from the request body; nothing stored or logged |
| `GET /api/finance/ledger.csv?month=YYYY-MM` | PIN cookie | The ledger as CSV (voided rows included, marked) |
| Meta webhook | signature | Only when `WHATSAPP_TRANSPORT=cloud` |
| everything else under `/api` | | 404 JSON |
| other paths | | The built dashboard (the page holds no data; the API needs the cookie) |

### tRPC procedures (all `protectedProcedure`)

The assistant's routers: `dashboard`, `settings` (`update` now also takes registration number, default advance %, next document number (forward only), document settings, reminder settings, expense categories, template-review dismissal), `projects`, `knowledgeGaps`, `conversations`, `shadowDrafts`, `testChat`, `whatsapp`, `summary`, `orders`, `insights`.

The pipeline's routers (`server/routers.pipeline.ts`):

| Router | Procedures |
|---|---|
| `jobs` | `list`, `get`, `draftFromConversation`, `create`, `update`, `approveQuotation`, `revokeApproval`, `startProject`, `markDelivered`, `close`, `markLost`, `reopen`, `pendingOrder` |
| `today` | `overview` |
| `meetings` | `list`, `create`, `update`, `cancel`, `complete`, `retrySync` |
| `tasks` | `list`, `add`, `update`, `remove`, `reorder`, `template`, `saveTemplate` |
| `documents` | `list`, `get`, `createQuotation`, `updateQuotation`, `duplicateQuotation`, `rejectQuotation`, `markSent`, `void`, `createInvoice`, `updateInvoice`, `createReceipt`, `createContract`, `updateContract`, `saveTechnical`, `saveDesign`, `templateReview` |
| `ledger` | `list`, `categories`, `recordPayment`, `recordExpense`, `void`, `updateNote`, `correct` |
| `finance` | `overview` |
| `renewals` | `list`, `add`, `update`, `createInvoice`, `recordPayment` |

A refusal the owner should read (a gate, a missing precondition) is a `PipelineError` turned into a tRPC error: `PRECONDITION_FAILED`, `NOT_FOUND`, `BAD_REQUEST` or `CONFLICT`.

---

## 4. Next steps
- Run `/graphify . --update` so the knowledge graph matches the code.
- `NotFound.tsx` is not used. Either route unknown paths to it or delete it.
- `Home.tsx` (router) and `HomePage.tsx` (landing page) have confusingly similar names.

---

## 5. Client pipeline module

A **Job** is one client's whole engagement. It is unrelated to the `projects` table and the Projects page, which are the AI assistant's training snapshots. Everything below is for one owner: no roles, no client portal, no e-signature. The owner downloads each PDF and sends it himself on WhatsApp.

### Stages (`shared/jobs.ts`, enforced again in SQL)
`lead` → `meeting` → `quoted` → `approved` → `active` → `delivered` → `closed`, plus `lost`.

| Stage | Entered by | Gate |
|---|---|---|
| `meeting` | adding a meeting (a lead moves automatically) | a meeting that is not cancelled |
| `quoted` | writing a quotation (moves automatically from lead or meeting) | a quotation exists. **A meeting is optional**: a lead can be quoted without one |
| `approved` | **Client approved** on one quotation that is `sent` | in one transaction: the job takes `price_total` and `advance_percent` from that quotation, it becomes `approved`, the job's other open quotations become `superseded` |
| `active` | **Start project** | the full advance (`price × advance% / 100`, 2 decimals, computed in the database); partial advances are not supported |
| `delivered` | **Mark delivered** | warns, does not block, about unfinished tasks; creates hosting, domain and support renewals one year on |
| `closed` | **Close job** | outstanding balance is zero |
| `lost` | **Mark lost**, before the project starts only | stores `lost_from_stage` and the reason; reopening restores that stage |

**Revoke approval** (only while `approved`) returns the job to `quoted`, clears the price, and restores the quotations that were superseded. A quotation goes `draft → sent → approved`, or ends `superseded` or `rejected`; an approved one is read-only (a database trigger enforces it).

**Start project** is one database function (`start_project`): it records the advance, copies the task template into the job, sets `started_at` and moves the stage, all or nothing. A client-supplied idempotency key and a unique index make a double click, a retry or concurrent calls return the first result.

### Documents (`server/documents/`)
One number sequence for every kind, five digits (`09248` first), issued by `issue_document_number()` inside the creating transaction; `documents.number` is unique. Only the form data is stored (`documents.payload`); the PDF is rebuilt on every download.

| Kind | Made from | Notes |
|---|---|---|
| Quotation | typed by hand, boilerplate from Settings | totals computed on the server; payment terms printed from the quotation's own advance % |
| Proposal & contract pack | the approved quotation | only when the stage is `approved` or later. Client, fee and payment split are read from the approved quotation and are not contract fields |
| Invoice | the required advance or the outstanding balance | asks for money; creates no ledger entry |
| Receipt | one live income entry | a snapshot; voiding the entry stamps the receipt VOID |
| Renewal invoice | a renewal record | |
| Technical / Design documentation | short forms | stored, so they must hold no passwords |
| Credentials & Access | typed at handover | **never stored**; see below |

`sent_at` is set only by **Mark as sent** (and **Mark as sent again**, which logs the old date); saving, editing and regenerating never touch it.

**Credentials are never stored.** The values travel in one `POST`, go into a PDF built in memory, and come back in the response. They are not in a database column, `documents.payload`, `event_log` (only "credentials PDF generated" and, when overridden, the unpaid balance), a log line, a file, the browser's storage or the query cache. The route parses its own body so a malformed one fails with a generic answer, and the app's final error handler never prints an error message. A test submits a sentinel string and searches the database, the events, everything the process printed, and the responses of malformed, oversized and failing requests.

### Finance (`shared/finance.ts`, `ledger_entries`)
LKR only, cash basis by `entry_date`, voided entries excluded everywhere, sums in whole cents.

| Entry | Company income | Job received | Outstanding | Project costs | Company costs |
|---|---|---|---|---|---|
| income `advance`, `final` | yes | yes | reduces it | | |
| income `extra` | yes | yes | no | | |
| income `renewal` | yes | yes | no | | |
| expense with a job | | | | yes | |
| expense without a job | | | | | yes |

Company profit = income − project costs − company costs. The hard rules live in the database (constraints, triggers, functions), because the server's service-role key bypasses row-level security:
1. Income always has a job.
2. Any entry with a job needs that job to have started (the only entry while `approved` is the advance written by Start project itself, after `started_at` is set in the same transaction).
3. Expenses may have no job (company expenses).
4. Entries are never deleted (a trigger refuses `DELETE` and `TRUNCATE`); mistakes are **voided** with a reason and, if needed, replaced. An entry that has a receipt keeps its amount, date, job and type; only the note may change.
5. The new tables and functions are closed to the browser key.

### Reminders (`server/pipeline-reminders.ts`)
Sent to the owner's WhatsApp through the existing `notifyOwner` path, 09:00 to 20:00 Colombo, at most 5 per pass. Each reminder has a unique key in `reminder_log`: quotation = (quotation, `sent_at`), balance = (job, `delivered_at`), renewal = (renewal, due date, `30d` or `7d`). The sender claims the row first (`claim_reminder()`), sends, then marks it sent; a failed send is retried up to 3 times with a growing wait; a claim whose owner vanished is taken over after 15 minutes. A restart, a second instance, or editing a document never causes a duplicate.

### Google Calendar (`server/integrations/`)
Optional and free. A **service account** (no refresh token to expire); the owner shares his calendar with its e-mail. The meeting is saved first and always succeeds; the sync follows and records `sync_status` (`pending | synced | failed | not_configured`) and the error. The event id is derived from the meeting id, so a retry updates instead of duplicating; cancelling deletes the event and treats 404 and 410 as done. Failed syncs retry with backoff (5, 10, 20, 40 minutes, 5 attempts) in the automation loop and by a Retry button. Out of scope: Meet links (a service account cannot create them), AI detection of meetings in chat.

### What the pipeline does not touch
The order state machine, the WhatsApp engine and the AI training flow are unchanged. An order waiting at `slip_received` for the job's conversation is shown on the job page with a button that calls the existing `orders.confirm`.
