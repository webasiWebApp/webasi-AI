# WEBASI AI — Client Pipeline, Documents & Finance Module (build prompt)

You are working inside the **WEBASI AI** repository (TypeScript, React 19 + Vite + Tailwind 4 + shadcn, tRPC 11 on Express, Supabase Postgres, Baileys WhatsApp, Vitest). The owner is one freelancer/agency (Praveen Maleesha, WEBASI, Sri Lanka). Add a **new module** to the existing dashboard that runs his whole client workflow, from first WhatsApp chat to project close, including documents (PDF) and finance.

Reference files (read them first). **They must be in the repo at `docs/reference/` before you start** (the System Overview, `chandranath__company.pdf`, `webasi_portfolio_project_doc.docx`). If any is missing, stop and ask the owner for it; do not guess the layout or the legal wording. Their text is also reproduced in Appendices A and B at the end of this file as a fallback for wording:
- `WEBASI AI - System Overview` (architecture, file map, sitemap, tRPC routers, migrations, env vars). It was written 2026-10-28. **The code is the source of truth where they disagree.**
- `chandranath__company.pdf` — a real quotation (the layout to reproduce).
- `webasi_portfolio_project_doc.docx` — the contract/NDA/credentials/invoice/documentation templates (the wording to reproduce).

---

## 0. How to work

1. **Read before writing.** Inspect `server/routers.ts`, `server/data/*`, `server/automation.ts`, `server/_core/{app,http-guards,env,notification}.ts`, `client/src/pages/Home.tsx`, `DashboardLayout.tsx`, `OrdersPage.tsx`, `ConversationsPage.tsx`, the latest migrations and `server/test-utils/fake-supabase.ts`. Follow existing conventions (zod validation, `protectedProcedure`, `recordEvent` for audit, data-layer module per area, tests next to code).
2. **Baseline first.** Before changing anything run `pnpm check`, `pnpm test` and `pnpm build` and write down every failure that already exists, so it is not blamed on this work.
3. **Post a short plan** (files to add/change, migration list, any new dependency with a one-line reason) before coding. Then build in the phases in section 9. Run the checks after each phase; do not move on with new failures.
4. **Do not break what exists.** Do not change the order state machine in `shared/webasi.ts`, the WhatsApp engine, or the AI training flow. The existing "Projects" page and `projects` table are **AI training snapshots** and are unrelated to this module.
5. **Naming, to avoid collision:** the new entity is called a **Job** (DB table `jobs`, router `jobs`, UI "Jobs"). Never reuse the names `projects` / "Projects".
6. Keep it simple. This is a one-owner tool. No roles, no client portal, no e-signature.

## 1. The workflow to implement

Every client is a **Job** that moves through these stages. Stage changes are server-enforced by a pure function in `shared/` (like the order state machine) with unit tests, and each change calls `recordEvent`.

```
lead -> meeting -> quoted -> approved -> active -> delivered -> closed        (+ lost, from any stage before active)
```

| Stage | Meaning | How a Job enters it | Gate (server-enforced) |
|---|---|---|---|
| `lead` | Client has chatted | Owner clicks **Create job** on a conversation (pre-fills client name and phone from the conversation) or creates one by hand | none |
| `meeting` | A meeting is booked | Owner adds a meeting to the job | at least one non-cancelled meeting |
| `quoted` | At least one quotation PDF exists | Owner fills the quotation form and generates it | a quotation exists (status `draft` or `sent`) |
| `approved` | Client said yes (over WhatsApp) to **one specific quotation** | Owner opens a quotation with status `sent` and clicks **Client approved** | the chosen quotation has status `sent`. In **one transaction**: set `jobs.approved_quotation_id`, copy `price_total` and `advance_percent` from that quotation, mark it `approved`, mark the job's other quotations `superseded` |
| `active` | Project started, work begins | Owner records the **full agreed advance** with **Start project** | stage is `approved`; amount ≥ `required_advance` = `price_total × advance_percent / 100` (2 decimals, computed server-side). Partial advances are **not** supported |
| `delivered` | Site is live and handed over for payment | Owner clicks **Mark delivered** | stage is `active`; warn (do not block) if tasks are unfinished |
| `closed` | Fully paid and done | Owner clicks **Close job** | outstanding balance is 0 |

Rules that matter:
- **Proposal & contract pack** can only be generated when the stage is `approved`, `active`, `delivered` or `closed` (never `lead`, `meeting`, `quoted` or `lost`), and only from the approved quotation.
- **Sent is not approved.** A quotation goes `draft → sent → approved`, or ends as `superseded` / `rejected`. Only the one in `jobs.approved_quotation_id` decides the price and payment schedule. After approval it is read-only. To change it the owner uses **Revoke approval**, allowed only while the job is still `approved` (before Start project): it returns the job to `quoted`, clears `approved_quotation_id` and `price_total`, restores the superseded quotations to `sent`, and is audited.
- **Start project is one atomic, idempotent action.** In one Postgres function/RPC (like `activate_project()`) it records the advance payment in the ledger, creates the task list from the template, sets `started_at`, and moves the stage to `active`. If any part fails, none of it persists. The form pre-fills `required_advance`, and the server rejects anything lower. Use a client-supplied idempotency key plus a unique constraint on the job's advance entry, so a double click, retry or concurrent call returns the existing result instead of creating a second payment or a second task list.
- **Money can only be recorded against a job that has been started** (see section 6). The advance payment recorded by Start project is the one allowed entry that *starts* the job.
- If the job's conversation has an existing **Order** waiting at `slip_received`, show it on the job page with a button that calls the existing order-confirm procedure. Do not duplicate or alter order logic. Starting a project must also work with no order at all.
- Moving backwards is not supported, except **Revoke approval** (above) and **lost**. Marking a job `lost` is allowed only before it is started, and stores `lost_from_stage`, `lost_reason` and an event. Reopening restores the stage in `lost_from_stage`. A started job cannot be marked lost; money mistakes on it are fixed by voiding ledger entries (section 6).

## 2. Pages (sidebar additions, same style as existing items)

Add routes in `client/src/pages/Home.tsx`, lazy-loaded like the others, and nav items in `DashboardLayout.tsx`. Mobile must work (the owner uses a phone).

1. **Today** (`/today`) — the replacement for Trello. One screen, no setup:
   - Meetings today and the next 7 days
   - Tasks due today or overdue, and the next unfinished task of each job in stage `active` **or** `delivered` (delivered jobs still have open tasks such as collect payment, credentials, feedback). Jobs that are `closed` or `lost` never appear
   - Money to chase: `approved` jobs waiting for the advance, `delivered` jobs with an outstanding balance (amount and days waiting)
   - Quotations sent with no answer for N days
   - Renewals due in the next 30 days
   Every row links to its job.
2. **Pipeline** (`/pipeline`) — columns for each stage with job cards (client, title, price, outstanding balance, next action). Create job button. No drag-and-drop required; moves happen through the gated buttons on the job page.
3. **Job page** (`/jobs/:id`) — tabs: **Overview** (stage, next action button, client, price, paid, outstanding), **Meetings**, **Documents**, **Tasks**, **Money**, **Renewals**, **Notes**.
4. **Calendar** (`/calendar`) — agenda list plus a simple hand-built month grid (do not add a calendar library). Add / edit / cancel / mark done.
5. **Finance** (`/finance`) — see section 6.
6. **Settings** — new sections: Business documents (section 5), Task template (section 4), Reminders (section 7).
7. **Lock screen** — see section 8.

## 3. Meetings and Google Calendar

- Built-in `meetings` table is the source of truth: `job_id`, `title`, `starts_at`, `ends_at`, `location_or_link` (free text), `notes`, `status` (`scheduled | done | cancelled`), `google_event_id`, `sync_status`.
- **Google Calendar sync is optional and free** (the Calendar API has no cost). Use a **service account**, not a user OAuth refresh token (refresh tokens for apps in "Testing" mode expire after 7 days). Owner shares his calendar with the service account email (Make changes to events). Env: `GOOGLE_SERVICE_ACCOUNT_JSON` (base64), `GOOGLE_CALENDAR_ID`. Minimal implementation: sign a JWT and call the REST API; prefer no heavy SDK. Meet links are out of scope (service accounts cannot create them); the free-text link field covers Zoom/Meet links pasted by hand.
- **Save first, sync after.** Saving a meeting always succeeds on its own. Sync then runs afterwards and records `sync_status` (`pending | synced | failed | not_configured`) and the error text. Retries must be safe: derive a deterministic Google event id from the meeting id (or store `google_event_id` and update instead of insert), so a retry never creates a duplicate; cancelling deletes the remote event and treats a 404 as success. Failed syncs are retried by the automation loop (max 5 attempts with backoff) and by a manual Retry button. If the env vars are missing the status is `not_configured` and the built-in calendar works alone.
- All times are `timestamptz`, displayed and entered in **Asia/Colombo**.
- Out of scope: AI detecting a meeting agreement in chat. The owner adds meetings by hand.

## 4. Task list (the A–Z checklist)

- **One standard template**, editable in Settings (add, rename, reorder, remove). Stored in the DB, seeded with this default:
  1. Requirement gathering (finalise SRS)
  2. Research (competitors, references, content)
  3. Sitemap and content collection
  4. UI/UX design
  5. Design approval from client
  6. Development (frontend and backend)
  7. Content upload and integrations (WhatsApp, Maps, social, forms)
  8. Basic SEO setup
  9. Testing (responsive, forms, speed, links)
  10. Deployment (domain, hosting, SSL, business emails)
  11. Google Search Console and indexing (submit sitemap)
  12. Analytics setup
  13. Final delivery to client
  14. Collect remaining payment
  15. Credentials handover
  16. Request client feedback
- "Request client feedback" is **just a task**. Build no feedback feature.
- Starting a project copies the template into `job_tasks` (`title`, `position`, `status: todo | doing | done`, optional `due_date`, `done_at`). Per job the owner can add, remove, reorder, tick, set a due date and add a note. Later template edits never change existing jobs.
- A simple checklist UI (checkboxes, progress "9 / 16"), not a kanban board.
- Optional `estimated_delivery_date` on the job (the quotation timeline is usually 7–10 days) feeds the Today page.

## 5. Documents (PDF generation)

The owner generates PDFs, **downloads them and sends them himself on WhatsApp**. Do not build sending, e-signature or a client link.

- Generate **server-side with a pure-JS library** (e.g. `pdfkit`), because Vercel serverless cannot run headless Chromium. Bundle any font you need in the repo. Use an Express route for downloads (for example `GET /api/documents/:id/pdf`) guarded by the same lock as everything else, `Content-Type: application/pdf`, `Content-Disposition: attachment`. Do not store PDF files; store the **form data** (`documents.payload jsonb`) and regenerate on demand, so edits and re-downloads are free.
- `documents`: `job_id`, `kind`, `number`, `payload jsonb`, `status`, `sent_at`, `ledger_entry_id` (receipts only), `voided_at`, `created_at`, `updated_at`. Quotation statuses: `draft | sent | approved | superseded | rejected`. Other kinds: `draft | sent | void`.
- **Numbering:** one shared sequence for all document kinds, 5-digit zero-padded (the sample shows `09247`). Settings holds `next_document_number`, meaning **the next number to issue** (default 09248). Numbers are issued only by an RPC that increments the counter inside one transaction and returns the value, and `documents.number` has a `UNIQUE` constraint. Never reuse or renumber, even when a document is voided or a later insert fails (a gap is acceptable, a duplicate is not). Test with concurrent calls.
- **`sent_at`:** set only by an explicit **Mark as sent** action, never by saving, editing or regenerating. Editing or regenerating a sent document keeps its `sent_at` and number. **Mark as sent again** is the only way to set a new `sent_at` (the old value is logged), and it is the only thing that restarts a reminder clock.
- Layout and wording come from the supplied files. Currency is **LKR**, formatted like `LKR 40,000`. Branding comes from Settings, not hardcoded.

### 5.1 Quotation (reproduce `chandranath__company.pdf`)
Header with REG NO (from Settings), title "PROJECT QUOTATION", document number, date, due date (default date + 30 days). Client name, project name, intro paragraph. A line-items table (description with optional bullet sub-items, cost in LKR), subtotal and total. Then sections: **Payment terms**, **Infrastructure**, **After service**, **Timeline & milestones**, **Relevant portfolio**, footer (`webasi.co | Reviews | Terms and Conditions`).
- **The form is fully manual**: the owner types client name, project name, intro, line items and prices. Do **not** pre-fill them from the chat.
- Boilerplate sections (payment terms text, after-service text, milestone text, portfolio links, footer) are pre-filled from Settings defaults (seed them from the sample PDF) and editable per quotation.
- Each quotation carries its own `advance_percent` (default 40, from Settings) and the printed payment terms are computed from it, e.g. "40% Advance Payment / 60% Upon Project Completion". On approval this value becomes the job's `advance_percent`. The approved quotation is the **single authoritative source for price and payment schedule**.
- Regenerating after an edit keeps the same number. "Duplicate as new" creates a new draft with a new number. A `sent` quotation that is edited stays `sent` with the same `sent_at`; an `approved` one is read-only.

### 5.2 Proposal & contract pack (only when stage ≥ `approved`)
One PDF assembled from the docx template: cover (Project Title, Project Name, Client Name, Date of Delivery), **Service Contract** (scope of work, deliverables, payment terms, timeline, intellectual property, confidentiality, warranty), **Non-Disclosure Agreement** (receiving party: Praveen Maleesha from WEBASI; 2-year term), **Support & Maintenance** (period and contact from Settings).
- Fill from the job and `approved_quotation_id`. Client, price and payment schedule are **read from the approved quotation and are not editable in the contract form**, so the quotation and the contract can never state different terms. Start date, estimated completion date and scope text are editable (scope defaults to the quotation's line items).
- Keep every legal clause editable as default text in Settings and as an override in the form. **Do not rewrite or "improve" the legal wording.**
- Known inconsistencies in the template. Preserve the wording as editable text, never silently fix or merge them, and **surface them to the owner**: show a dismissible "Template review needed" notice in Settings and on the contract form until he dismisses it, and list them in your final summary.
  - Agreement date line reads "[Start Date] – [30 days after delivery]", which does not say what the end date means. Keep separate editable fields for agreement date, start date and estimated completion date.
  - Contract warranty is 30 days while the quotation promises 1 year of free support. Keep them as two separate editable clauses; never treat them as the same term.
  - The template's example payment split is 50/50 while the real one is 40/60. The contract must always take the split from the approved quotation (above), never from template text.

### 5.3 Invoice and receipt
Same visual style as the quotation. They are different documents with different sources:
- **Invoice** (a request for money; nothing has been paid yet): generated from the job's **required advance** (`price_total × advance_percent / 100`), its **outstanding balance**, or a **renewal** (5.4). It does **not** need, and must not create, a ledger entry. Columns Description / Amount (LKR), client name and phone, invoice number, date, due date, payment method, total due. Its payload is a snapshot of the amounts at generation.
- **Receipt** (proof that money arrived): generated only from an actual, non-voided **income ledger entry** (`documents.ledger_entry_id`). Its payload is an immutable snapshot of that entry (amount, date, method, balance after payment) taken at generation.
- Optional: when recording a payment the owner may pick the invoice it settles (`ledger_entries.invoice_document_id`). This is informational and changes no totals.
- **Linking rules that protect the records:** ledger entries are never hard-deleted (section 6). An entry that has a receipt cannot have its amount, date, job or type edited; the owner **voids** it with a reason and records a new entry, and the old receipt is automatically marked `void` (kept, still downloadable, stamped VOID). `documents.ledger_entry_id` is `ON DELETE RESTRICT`. Editing only the note of an entry is allowed.
- Both can be created in one click from the Money tab.

### 5.4 Renewal invoice
Generated from a renewal record (section 7). Same style.

### 5.5 Delivery documents (build last; lowest priority)
- **Credentials & Access** PDF from the docx table (Service / URL / Username / Password) plus the support section.
  - The owner types the values into a form at handover. **Credentials are never stored.** No DB row with values, no `documents.payload`, no entry in `event_log`, no pino log line, no client-side persistence (no localStorage, no query cache). Use a `POST` that streams the PDF back with `Cache-Control: no-store`, and make sure request bodies for that route are not logged. Record only an event like "credentials PDF generated for job X" with no values.
  - Gate: allowed only when the outstanding balance is 0. If not, show a warning and require an explicit confirm to override; log the override.
  - Exclude the credentials request body from application logs, error reports and any request-body tracing (configure pino redaction and the error handler explicitly; also check any middleware that echoes bodies).
  - Do not put credential values in browser storage, the TanStack Query cache, analytics or the URL. Submit with a plain `fetch` POST, not a cached query/mutation that keeps its variables.
  - Build the PDF in memory and stream it. Never write it to disk or persistent temp storage.
  - Tests must prove the values never appear in DB rows, audit events, logs or error messages (submit a sentinel string and search all of them, including a forced server error).
- **Technical Documentation** and **Design Documentation** PDFs from short forms (stack, install/deploy steps, APIs; sitemap, Figma link, colours, fonts, responsive notes). Store the payload (it contains no secrets; say so in the form and never put passwords in it).

## 6. Finance (project and company)

Simple ledger, LKR only. No tax, payroll, assets or bank reconciliation.

`ledger_entries`: `id`, `job_id` (nullable), `type` (`income | expense`), `category`, `amount numeric(14,2) > 0`, `entry_date`, `method` (bank transfer, cash, PayPal, other), `note`, `invoice_document_id` (nullable, informational), `voided_at`, `voided_reason`, `replaces_entry_id` (nullable), `idempotency_key` (unique, nullable), `created_at`.

Hard rules, enforced **in the data layer and in the database** (CHECK constraint or trigger, with tests):
1. **Income always has a `job_id`.**
2. **Any entry with a `job_id` requires that job to be started** (`started_at` is set, so stage `active`, `delivered` or `closed`). The only entry allowed while the job is `approved` is the advance payment written by Start project itself.
3. **Expenses may have no `job_id`.** Those are **company expenses** (internet, subscriptions, ads, own salary, etc.).
4. **Ledger entries are never hard-deleted.** A database trigger rejects `DELETE`. Mistakes are fixed by **voiding** (requires a reason, sets `voided_at`) and, if needed, recording a replacement (`replaces_entry_id`). Voided entries stay visible in an audit view and are excluded from every total. An entry with a receipt cannot have amount, date, job or type changed (5.3). Every change goes through an audited procedure (`recordEvent`).
5. These rules must hold even if a server code path is buggy: put them in CHECK constraints, triggers and RPCs. The server uses the Supabase service-role key, which **bypasses RLS**, so RLS alone is not protection. Revoke direct table access from the anon and authenticated roles, and test by calling the database/API directly, not just through the UI.

Categories: income — `advance`, `final`, `renewal`, `extra`; expense — `hosting`, `domain`, `software`, `freelancer`, `ads`, `internet`, `salary`, `other` (editable list in Settings).

How each entry counts (cash basis, by `entry_date`, voided entries excluded everywhere):

| Entry | Company income | Job "received" | Job outstanding (project price) | Project costs | Company costs |
|---|---|---|---|---|---|
| Income `advance`, `final` | yes | yes | **reduces it** | no | no |
| Income `extra` (work beyond the quoted price) | yes | yes | does not reduce it | no | no |
| Income `renewal` | yes | yes | does not reduce it (tracked on the renewal record) | no | no |
| Expense with `job_id` | no | no | no | **yes** | no |
| Expense without `job_id` | no | no | no | no | **yes** |

- Job outstanding = `price_total` − sum of `advance` + `final` income, never below 0 for display; show overpayment separately.
- Job profit = all income of that job − that job's costs.
- Company profit = all income − project costs − company costs.
- Outstanding receivables on the Finance page = outstanding of started jobs, plus invoiced-but-unpaid renewals shown as a separate line. Add fixture tests for each row so renewal and extra income are neither double-counted nor dropped.

**Job Money tab:** price (from approved quotation), advance due, received, outstanding, project costs, project profit (received − costs). Buttons: Record payment (with Invoice/Receipt shortcut), Add expense.

**Finance page**, with a month selector and "All time":
- Income, project costs, company costs, **company profit = project income − project costs − company costs**
- Outstanding receivables (sum over started jobs) and a list of who owes what
- Per-job table: price, received, outstanding, costs, profit
- Monthly trend (simple bar or line using what the repo already has; add no heavy chart dependency)
- CSV export of the ledger for the selected range

Money math: do it in integer-safe fashion (cents or `numeric`), never floats for sums. Add tests for totals, the three hard rules and the edit-after-start cases.

## 7. After delivery: renewals, and WhatsApp reminders to the owner

**Renewals.** When a job is marked delivered, create default renewal records: hosting, domain and support, each due **delivery date + 1 year**, amount editable, status `upcoming | invoiced | paid | skipped`. Owner can add/edit/skip renewals per job. **Generate renewal invoice** produces the PDF (5.4). Recording its payment creates an income entry of category `renewal` (allowed, since the job is started).

**Reminders to the owner on WhatsApp** (reuse the existing owner-notification path used by handover reminders and the weekly summary; do not invent a new sender). Add them to the existing loop in `server/automation.ts` (it only runs off Vercel, as today). Types:
- Quotation with status `sent` (not approved, superseded or rejected) and unanswered for N days (default 3), counted from `sent_at`
- Delivered job with an outstanding balance for N days (default 3), counted from `delivered_at`
- Renewal due in 30 days and again in 7 days
Rules: respect the existing sending hours (09:00–20:00 Asia/Colombo) and caps; **idempotent** via a `reminder_log` table. Unique key per reminder: quotation = (`quotation_id`, `sent_at`); balance = (`job_id`, `delivered_at`); renewal = (`renewal_id`, `due_date`, `30d` or `7d`). Claim the row first (insert; a unique violation means someone already did it), then send, then mark it `sent`; mark failures `failed` and retry up to 3 times with backoff. A restart, a second instance, or editing/regenerating a document must never cause a duplicate or reset the clock; thresholds and on/off toggles in Settings. Each message is one short line with the client name and amount.

## 8. Lock screen (PIN) — replaces the Basic-auth password

- New env var `DASHBOARD_PIN`. A **PIN screen** guards the whole dashboard. On success the server sets a **signed, httpOnly, SameSite=Lax, Secure-in-production cookie** (sign with the existing `JWT_SECRET`); `/api/trpc/*` and the document routes require it. No usernames, no accounts.
- Compare the PIN with a **constant-time** check. Rate-limit attempts (for example 5 per minute per IP with a growing lockout) using the existing limiter style. Add a Lock/logout button.
- This **replaces** `DASHBOARD_PASSWORD` Basic auth: remove the Basic-auth challenge, keep the env var documented as deprecated for one release, and update the overview doc.
- Keep `/api/keepalive` and `/healthz` open (the uptime workflow pings them). The Meta webhook keeps its own signature check. Keep all existing security headers.
- If `DASHBOARD_PIN` is unset: in production, refuse to serve the dashboard or API (503 with a clear message); in development, allow access with a console warning.

## 9. Delivery phases

0. **PIN lock** (section 8) + tests.
1. **Data model and stage machine:** migration(s) in `supabase/migrations/` using the repo's dated naming (next after `20261011_…`), tables `jobs`, `meetings`, `job_tasks`, `task_templates`, `documents`, `ledger_entries`, `renewals`, `reminder_log`, new `settings` fields, RPCs for the atomic counters and Start project, RLS/lockdown consistent with migration `002` (but see section 6 rule 5: the financial rules must live in constraints, triggers and RPCs, not in RLS). Data modules under `server/data/`, shared stage function, tests (extend the fake Supabase as needed; use PGlite for the constraints and RPCs, as the repo does for migrations).
2. **Jobs, Pipeline, Job page, Today, Tasks** and the **Create job** button on Conversations.
3. **Meetings + Calendar page + optional Google sync.**
4. **PDFs:** quotation, proposal & contract, invoice/receipt.
5. **Finance** (ledger, Money tab, Finance page, CSV).
6. **Renewals, renewal invoice, reminders.**
7. **Delivery documents** (credentials, technical, design).
Finish with: updated overview doc (sitemap, routers, tables, env vars), `.env.example` additions, and a short owner guide (how to set `DASHBOARD_PIN`, the Google service account setup, and how to edit templates).

## 10. Testing requirements

1. Record the baseline (section 0) and compare against it at the end.
2. Apply **every** new migration to a clean test database (PGlite, as the repo does) and to a database already at the previous migration; test the failure and recovery path where the platform supports it (for example a migration re-run must not error).
3. Database-level tests, calling the DB/RPCs directly: duplicate document numbers under concurrent calls; concurrent and repeated Start project (one payment, one task list); duplicate advance payments; income without a job; entries on non-started jobs; ledger `DELETE`; editing an entry that has a receipt; approving a quotation that is not `sent`; two quotations approved concurrently.
4. Every workflow transition is tested through the **API** (tRPC) and, for the main path, through the **UI** (stage gates, disabled/hidden actions, error messages).
5. Production authentication: PIN missing in env (503), wrong PIN, rate limit, expired/tampered cookie, successful login, logout.
6. Reminders: retries after a failed send, process restarts, two instances running, edited/regenerated documents, and sending-hour limits, all without a duplicate WhatsApp message.
7. Calendar: sync failure, retry without duplicates, cancel of an already-deleted remote event.
8. Verify mobile usability at 360 px width for Today, Pipeline, Job page, Money and the lock screen.
9. Credentials sentinel test (5.5).

## 11. Acceptance checklist (all must pass)

- [ ] `pnpm check`, `pnpm test`, `pnpm build` are green; existing tests are unchanged and passing.
- [ ] Without the PIN cookie, `/api/trpc/*` and PDF routes return 401; `/healthz` stays open; wrong PINs are rate-limited.
- [ ] A conversation can become a job in one click; a job cannot skip a gated stage via the API (tested).
- [ ] Proposal & contract cannot be generated before `approved`.
- [ ] Start project twice creates exactly one payment and one task list; a failure midway leaves nothing behind.
- [ ] A direct insert/API call recording income or a job-linked expense for a non-started job is rejected by the database as well as the app; a company expense with no job is accepted.
- [ ] Company profit on the Finance page equals project income − project costs − company costs (tested with fixtures).
- [ ] Quotation PDF visually matches `chandranath__company.pdf` (header, table, payment terms, infrastructure, after service, timeline, portfolio, footer); numbers are unique and sequential under concurrent requests.
- [ ] Credentials PDF: grep of the DB schema, `event_log` writes, logs and client code shows no stored credential values.
- [ ] With no Google env vars the calendar still works; with them, creating/editing/cancelling a meeting syncs, and a Google outage does not block saving.
- [ ] Reminders never send twice across restarts and never send outside 09:00–20:00 Colombo.
- [ ] Only the quotation in `approved_quotation_id` sets the price; approving selects it and sets `price_total` in one transaction; the contract cannot disagree with it.
- [ ] Start project rejects an advance below `required_advance`, and is idempotent and atomic under concurrency.
- [ ] Invoices can be generated with no ledger entry; receipts only from a real entry; voiding an entry marks its receipt void; ledger rows cannot be deleted.
- [ ] Editing or regenerating a sent quotation never changes `sent_at`, so quotation reminders neither reset nor duplicate.
- [ ] A lost job reopens to its `lost_from_stage`.
- [ ] Mobile layout is usable for Today, Pipeline, the Job page and Money.

## 12. Explicitly out of scope (do not build)

E-signature or client approval links; sending PDFs through WhatsApp automatically; AI meeting detection from chat; multi-user accounts or roles; a client portal; a feedback feature (feedback is only a task); credentials storage; tax, payroll or bank reconciliation; non-LKR currencies; warranty/support countdown timers; drag-and-drop kanban; partial advance payments; hard-deleting ledger entries.

## 13. Final summary format

When done, report: what was built per phase; **the list of files changed**; migrations added and confirmation each applied to a clean database; the tests run with pass/fail counts compared with the baseline; new env vars; new dependencies and why; anything you deviated from; the three template inconsistencies from 5.2; and **every integration you could not verify** (for example Google sync without real credentials, or WhatsApp reminders without a live session).

---

## Appendix A — Contract pack wording (from `webasi_portfolio_project_doc.docx`)

Fallback only. If the `.docx` is in `docs/reference/`, it wins. Square brackets are fields to fill. Keep all of this editable. Do not reword it.

**Cover:** Project Title: Portfolio Web Development · Project Name · Client Name · Date of Delivery

**Service Contract** — "This Agreement is made on [Start Date] – [30 days after delivery] between:" (parties)
1. **Scope of Work.** The Freelancer agrees to develop a website as per the client's requirements. This is the requirements outline.
2. **Deliverables.** Source files (If use WordPress/CMS don't provide source code); Credentials; Domain Name; Hosting Service; Admin Panel.
3. **Payment Terms.** Total Fee: $[Amount]. Payment Schedule: [e.g., 50% upfront, 50% on delivery]. Payment Method: [Bank transfer, PayPal, etc.]. Advance payment is required to initiate the project. Remaining balance due upon final delivery.
4. **Timeline.** Project start date: [Date]. Estimated completion date: [Date].
5. **Intellectual Property.** Upon full payment, all intellectual property rights in the deliverables will transfer to the Client.
6. **Confidentiality.** Both parties agree to keep confidential information private as per the attached NDA.
7. **Warranty.** The Freelancer warrants that the deliverables will function as specified for 30 days after delivery.

(The template shows `$` and a 50/50 example. The real documents use **LKR** and the split from the approved quotation.)

**Non-Disclosure Agreement (NDA)** — "…entered into as of [Start Date] – [30 days after delivery], by and between: Disclosing Party: [Client Name]. Receiving Party: Praveen Maleesha from WEBASI."
1. **Definition of Confidential Information.** Any data or information, oral or written, disclosed by the Disclosing Party to the Receiving Party that is not generally known to the public. Ex: service credentials.
2. **Obligations of Receiving Party.** Maintain confidentiality of the Confidential Information. Use the information solely for the purpose of project. Not disclose Confidential Information to any third party without prior written consent.
3. **Exclusions.** Does not include information that: is or becomes publicly available without breach of this Agreement; was known to the Receiving Party prior to disclosure; is independently developed by the Receiving Party.
4. **Term.** This Agreement shall remain in effect for 2 years from the date of disclosure.
5. **Return of Materials.** Upon request, the Receiving Party shall return or destroy all Confidential Information.
"IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first above written." (signature blocks)

**Support & Maintenance.** Support period: 30 days. Contact for support: info@webasi.co | +94 76 066 8556.

**Invoice** (table): Invoice Number · Invoice Date · Due Date · Client Name · Phone. Rows: Description / Amount (LKR): UI Design and Development; Hosting Service; Domain Registry; **Total Amount Due**. Footer: Payment Terms; Payment Method: [Bank Transfer / PayPal / Check / Other]; Payment Due By: [Due Date].

**Credentials & Access** (table): Service · URL · UserName · Password. Rows: Hosting Service; Domain Registar; (blank rows).

**Technical Documentation:** 1. Overview (technology stack and architecture) · 2. Technologies Used (Frontend, Backend, Database) · 3. Installation & Deployment (set up locally, deploy to production) · 4. APIs / Plugin and Its Integrations (third-party APIs, authentication, endpoints).

**Design Documentation:** 1. Sitemap · 2. Wireframes & UI Design (attach or link; [Figma Link here]) · 3. Style Guide (Colors: primary, secondary, accent; Typography: fonts) · 4. Responsive Design.

## Appendix B — Quotation structure (from `chandranath__company.pdf`)

Fallback only. If the PDF is in `docs/reference/`, match it visually.

- Top right: `REG NO: 260223052`; `INVOICE NO: 09247`, `DATE: 16.10.2026`, `DUE DATE: 16.11.2026`. Title: **PROJECT QUOTATION**.
- `PROJECT NAME : chandranath & company` · `CLIENT NAME : Prablo 360`
- Intro paragraph: "The website will include all sections requested in the RFQ, including pages content, business information, galleries, packages, contact information, Google Maps, WhatsApp integration, social media integration, and future-ready structure for additional locations."
- Table `DESCRIPTION (INITIAL DEVELOPMENT)` / `COST (LKR)`: **Website Design & Development — 40,000**, with bullets: Responsive design (Mobile, Tablet & Desktop); Up to 10 main pages; Policy pages; Image galleries; Packages / Menu sections; Customer Reviews; Contact Form; WhatsApp Integration; Google Maps Integration; Social Media Integration; Basic SEO Setup; SSL Configuration; Google Analytics Integration; Speed Optimization; 5 Businesses Emails; Hosting for 1 year; Domain for 1 year. Then **SUBTOTAL 40,000**, **TOTAL 40,000**.
- **PAYMENT TERMS:** 40% Advance Payment · 60% Upon Project Completion
- **INFRASTRUCTURE:** Technology: Next js · Domain: .com domain for 1 year · Hosting: namecheap
- **AFTER SERVICE:** Free 01 Year after delivery support (We charge for major updates) · Money back guarantee
- **TIMELINE & MILESTONES:** Estimated Duration: 7-10 Calendar Days. Requirement Gathering: finalizing the SRS (Software Requirements Specification) document. UI/UX Design: creating the visual layout for client approval. Development: backend and frontend coding (commences after design approval). Testing & Delivery: final quality checks and deployment to the live server.
- **RELEVANT PORTFOLIO:** webasi.co and six site links (theplatinuminteriors.com, donovanwashington.com, 4elementsboxing.com, prablo360.com, avix.one, thecircularflow.com). These are sample defaults; the real list is editable in Settings.
- Footer on each page: `webasi.co | Reviews | Terms and Conditions`.
- Note: the odd letter-spacing in the sample's body text is a rendering artifact of the source PDF. Do not copy it.