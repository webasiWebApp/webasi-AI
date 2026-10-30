# WEBASI AI - System Overview

An AI WhatsApp sales assistant with an owner dashboard. Clients message a WhatsApp number. The assistant qualifies them, answers from a trained project snapshot, collects an order brief, requests a deposit slip, and hands over to the owner when it can't answer. The owner runs everything from a web dashboard.

> Sources: the repository itself (read 2026-10-28) and the graphify output in `graphify-out/`. The graph was built on 2026-09-26 and is **out of date**. It still lists `mysql2`, drizzle, S3 and about 40 shadcn components that are no longer in the repo. Where the graph and the code disagree, this document follows the code.

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
| LLM | Gemini (default) or Groq, chosen at runtime. Model defaults: `gemini-3.8-flash` (`GEMINI_MODEL`), `gemini-3-flash-preview` (`WEBASI_LLM_MODEL`) |
| Logging | pino |
| Tests | Vitest 4, in-memory fake Supabase, PGlite (in-process Postgres) for migrations |
| CI | GitHub Actions (`ci.yml`: type check, tests, build; `uptime.yml`: keep-alive ping) |
| Hosting | Vercel (`vercel.json`, `api/index.ts`) and Render (the code comments mention Render TLS termination) |

### Architecture

```
 WhatsApp client
      |
      v
 +-----------------+      +---------------------------+
 | Baileys         |  or  | Meta Cloud webhook        |   WHATSAPP_TRANSPORT = baileys | cloud
 | server/whatsapp |      | server/webhooks/whatsapp  |
 +--------+--------+      +-------------+-------------+
          |  per-chat queue, dedupe     |
          +--------------+--------------+
                         v
              conversations/processor.ts          claim message (dedupe), caps, state machine
                 |            |          |
                 |            |          +--> sender.ts / whatsapp/outbound.ts  (rate limit, 24h window, hours)
                 |            +-------------> faq-cache.ts / faq-generator.ts  (instant answers, no AI call)
                 v
              conversations/engine.ts  ---->  _core/llm.ts --> gemini.ts | groq.ts   (failover, rpm limits)
                 |
                 v
              db.ts + module-db.ts + data/*   ---->  Supabase (Postgres)
                 ^
                 |
   routers.ts (tRPC) <----  /api/trpc  <----  React dashboard (client/)
   automation.ts (timers: follow-ups, handover reminders, weekly summary, retention)
```

### Message flow (one inbound message)
1. **Transport** receives the message. Baileys sessions are encrypted and stored in `baileys_auth_state`, so they survive restarts. A per-chat queue (`chat-queue.ts`) keeps one chat's messages in order.
2. **`processWhatsAppMessage()`** (`conversations/processor.ts`) claims the message ID in the `messages` table. A unique-key violation (`23505`) means a duplicate, so it is dropped. Voice notes get a fixed "please type it" reply.
3. **Owner takeover and shadow mode.** If the chat is paused or handed over, WEBASI stays silent. In shadow mode it saves a draft in `DraftsPage` for the owner to send or discard instead of replying.
4. **Instant answers.** The FAQ cache (`faq-cache.ts`, built by `faq-generator.ts` from training) answers common questions without an AI request.
5. **Engine.** Otherwise `engine.ts` builds a turn (state, missing fields, recent messages, caps) and calls the LLM provider. The reply is structured: intent score, sentiment, objection, next order state.
6. **Guards.** Monthly outbound cap (`WHATSAPP_MONTHLY_CAP`, default 900), daily AI cap (`GEMINI_DAILY_CAP`, default 500), Baileys rate limit (8 per minute) and 24-hour reply window all apply. Usage is counted atomically through the `increment_usage_counter` RPC.
7. **Persist and notify.** Messages, order state, events (`recordEvent`) and knowledge gaps are written. The owner is notified when a handover happens.

### Order state machine (`shared/webasi.ts`)
`new` → `collecting` → `brief_complete` → `awaiting_deposit` → `slip_received` → `confirmed_by_owner`
Side states: `needs_owner`, `paused`, `abandoned`, `cancelled`. The owner confirms an order only after a slip is received.

### Background jobs (`server/automation.ts`)
Run every 15 minutes (`CHECK_INTERVAL_MS`), only when not on Vercel:
- **Follow-ups**: a nudge 6 to 23 hours after a client's last message, inside the WhatsApp reply window.
- **Sending hours**: 09:00 to 20:00 Asia/Colombo only.
- **Handover reminders** (`HANDOVER_REMINDER_HOURS`, default 2).
- **Weekly summary** to the owner.
- **Retention**: deletes old events and messages if `EVENT_LOG_RETENTION_DAYS` / `MESSAGE_RETENTION_DAYS` are set (default keep everything).

### Security and hardening (`server/_core/app.ts`, `http-guards.ts`)
- Optional HTTP Basic password for the whole dashboard (`DASHBOARD_PASSWORD`). Without it, the URL is the secret, so `X-Robots-Tag: noindex` is always set.
- Content Security Policy (production), `X-Frame-Options: DENY`, `nosniff`, HSTS on HTTPS, restrictive `Permissions-Policy`.
- Rate limits on `/api/trpc`: 240 per minute per address, and 20 per minute for calls that spend AI requests (`testChat.turn`, `projects.regenerateInstantAnswers`, `projects.approveTraining`).
- JSON body limit 100 KB.
- `/api` unknown paths return 404 JSON, not the dashboard page.
- Meta webhook signature checking (`WHATSAPP_APP_SECRET`) when using the cloud transport.

### Database (Supabase migrations in `supabase/migrations/`)

| Migration | Adds |
|---|---|
| `001_initial_schema.sql` | `settings`, `projects`, `conversations`, `messages`, `event_log`, `baileys_auth_state`, `usage_counters`, `training_sessions`, `insights` |
| `002_orders_and_lockdown.sql` | `orders` and access lockdown |
| `003_client_behaviour.sql` | client behaviour fields |
| `004_followups_and_weekly_summary.sql` | follow-up and weekly summary support |
| `20261002_increment_usage_rpc.sql` | `increment_usage_counter()` |
| `20261004_knowledge_gaps.sql` | `knowledge_gaps` |
| `20261011_atomic_writes_and_indexes.sql` | `append_conversation_message()`, `activate_project()`, indexes |

When a function is missing (migration not applied), `db.ts` falls back to a non-atomic path and stops retrying the RPC.

### Configuration (environment variables, `server/_core/env.ts`)
- **Core**: `NODE_ENV`, `PORT`, `JWT_SECRET`, `DASHBOARD_PASSWORD`
- **Database**: `SUPABASE_URL` (or `VITE_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`
- **AI**: `AI_PROVIDER` (gemini | groq), `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_RPM_LIMIT` (5), `GEMINI_DAILY_CAP`, `GROQ_API_KEY`, `WEBASI_ENABLED`, `WEBASI_LLM_MODEL`, `FAQ_ENGLISH_FOR_SINGLISH`
- **WhatsApp**: `WHATSAPP_TRANSPORT`, `BAILEYS_PHONE_NUMBER`, `BAILEYS_SESSION_ENCRYPTION_KEY`, `BAILEYS_RATE_LIMIT_PER_MINUTE`, `WHATSAPP_MONTHLY_CAP`, and for the cloud transport `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_OWNER_WA_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_GRAPH_VERSION`
- **Limits and retention**: `API_RATE_LIMIT_PER_MINUTE`, `AI_RATE_LIMIT_PER_MINUTE`, `HANDOVER_REMINDER_HOURS`, `EVENT_LOG_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS`

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | `tsx watch` the server, with Vite middleware for the client |
| `pnpm build` | Vite build to `dist/public`, then esbuild bundles the server to `dist/index.js` |
| `pnpm start` | Run the production bundle |
| `pnpm check` | `tsc --noEmit` |
| `pnpm test` | `vitest run` |
| `pnpm eval` | `scripts/eval-engine.ts`, an offline evaluation of the engine |

### Known risks
- Baileys is **not an official WhatsApp API**. The number can be logged out or banned. `BAILEYS.md` recommends the Meta Cloud API for a production-critical number.
- Background jobs and the Baileys connection do not run on Vercel (serverless), so those need a long-running host such as Render.
- Free-tier LLM limits are tight: Gemini 5 requests per minute, Groq 8k tokens per minute.
- Real traffic is mostly Singlish, and the demo project overstates what the live data shows (see the memory notes).

---

## 2. File system

```
webasi-AI/
├─ api/
│  └─ index.ts                  Vercel serverless entry; re-exports the Express app
├─ client/
│  ├─ index.html
│  ├─ public/
│  └─ src/
│     ├─ main.tsx               React entry, tRPC + Query providers
│     ├─ App.tsx                ErrorBoundary > Theme > Tooltip > DashboardLayout > Home
│     ├─ index.css              Tailwind 4 styles
│     ├─ pages/                 one file per dashboard page (see Sitemap)
│     ├─ components/
│     │  ├─ DashboardLayout.tsx sidebar + nav items
│     │  ├─ ErrorBoundary.tsx
│     │  ├─ dashboard/shared.tsx shared dashboard widgets
│     │  └─ ui/                 avatar, button, card, dialog, dropdown-menu, input,
│     │                         separator, sheet, sidebar, skeleton, sonner, tooltip
│     ├─ contexts/ThemeContext.tsx
│     ├─ hooks/                 useComposition, useMobile, usePersistFn
│     └─ lib/                   trpc.ts (client), utils.ts (cn)
├─ server/
│  ├─ _core/                    infrastructure
│  │  ├─ index.ts               process entry: server, Baileys start, automation start, Vite/static
│  │  ├─ app.ts                 createApp(): headers, auth, health, rate limit, tRPC
│  │  ├─ env.ts                 ENV object
│  │  ├─ context.ts, trpc.ts    tRPC context and procedures
│  │  ├─ http-guards.ts         dashboard password, rate limiter
│  │  ├─ rate-limit.ts          LLM request limiter
│  │  ├─ llm.ts, gemini.ts, groq.ts   provider layer
│  │  ├─ supabase.ts            Supabase client and connection check
│  │  ├─ notification.ts        owner notifications
│  │  └─ vite.ts                dev middleware / static serving
│  ├─ conversations/
│  │  ├─ processor.ts           inbound message handling
│  │  ├─ engine.ts              LLM turn and structured reply
│  │  ├─ project.ts             approved project snapshot types
│  │  ├─ sender.ts              outbound send with caps
│  │  ├─ faq-cache.ts           instant-answer matching
│  │  └─ faq-generator.ts       builds instant answers from training
│  ├─ whatsapp/
│  │  ├─ baileys.ts             transport (pairing, status, reconnect, reset)
│  │  ├─ baileys-auth.ts        encrypted session store
│  │  ├─ chat-queue.ts          per-chat serial queue
│  │  └─ outbound.ts            send helper for either transport
│  ├─ webhooks/whatsapp.ts      Meta Cloud webhook (used when transport = cloud)
│  ├─ data/                     data layer, one module per area
│  │  └─ core, settings, projects, training, conversations, orders,
│  │     events, insights, drafts, retention, stats
│  ├─ db.ts                     conversation and usage helpers
│  ├─ module-db.ts              re-exports ./data/*
│  ├─ routers.ts                tRPC appRouter
│  ├─ automation.ts             timers: follow-ups, reminders, weekly summary, retention
│  ├─ test-utils/fake-supabase.ts
│  └─ *.test.ts                 about 35 test files next to the code they cover
├─ shared/
│  ├─ webasi.ts                 order state machine, required fields, reply rules
│  └─ _core/errors.ts
├─ supabase/
│  ├─ README.md
│  └─ migrations/               7 SQL files
├─ scripts/eval-engine.ts       engine evaluation
├─ public/fonts/                Font Awesome webfonts
├─ .github/workflows/           ci.yml, uptime.yml
├─ graphify-out/                knowledge graph (generated, out of date)
├─ BAILEYS.md                   transport notes
├─ task.md, .completion-notes.md, .external-notes.md, .visual-check.md   working notes
├─ template.json, recompile-snapshot.ts
├─ vercel.json, vite.config.ts, vitest.config.ts, tsconfig.json
├─ components.json              shadcn config
└─ package.json, pnpm-lock.yaml, pnpm-workspace.yaml, patches/
```

Untracked/ignored locally: `node_modules/`, `dist/`.

---

## 3. Sitemap

### Dashboard pages (client)
Routing is path-based in `client/src/pages/Home.tsx` (wouter `useLocation`). Every page except the landing page is lazy-loaded. An unknown path shows the landing page; `NotFound.tsx` exists but is not wired in.

| Path | Sidebar label | File | Purpose |
|---|---|---|---|
| `/` | Home | `HomePage.tsx` | Overview: settings, active project, usage, conversations, orders, events |
| `/projects` | Projects | `ProjectsPage.tsx` | Create, approve and activate projects; manage instant answers |
| `/training` | Training | `TrainingPage.tsx` | Answer training questions, save and approve training |
| `/test-chat` | Test Chat | `TestChatPage.tsx` | Try the assistant against a project without WhatsApp |
| `/conversations` | Conversations | `ConversationsPage.tsx` | Read chats; pause, resume, or send as owner |
| `/drafts` | Drafts | `DraftsPage.tsx` | Shadow-mode drafts: edit and send, or discard |
| `/connect-whatsapp` | Connect WhatsApp | `ConnectWhatsApp.tsx` | Pairing code, connection status, reconnect, reset session |
| `/orders` | Orders | `OrdersPage.tsx` | Orders list; confirm once a slip is received |
| `/insights` | Insights | `InsightsPage.tsx` | AI-suggested insights to approve or dismiss |
| `/settings` | Settings | `SettingsPage.tsx` | Business name, bank details, caps, toggles, AI provider |
| `/events` | Event Log | `EventsPage.tsx` | Audit trail |

### HTTP endpoints (server)

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/keepalive` | none (password if set) | Uptime ping |
| `GET /health` | same | Supabase and WhatsApp connection state; 503 when down or reconnect required |
| `GET /healthz` | same | Plain liveness |
| `/api/trpc/*` | same, plus rate limits | The tRPC API below |
| Meta webhook | signature | Registered only when `WHATSAPP_TRANSPORT=cloud` (`server/webhooks/whatsapp.ts`) |
| `/api/*` (other) | | 404 JSON |
| everything else | | Static dashboard (`dist/public`), or Vite in development |

### tRPC procedures (`server/routers.ts`)
All are `protectedProcedure`.

| Router | Procedures |
|---|---|
| `dashboard` | `overview`, `conversations`, `orders`, `events`, `insights`, `projects`, `settings` |
| `settings` | `update`, `updateProvider` |
| `projects` | `create`, `approve`, `activate`, `training`, `saveTraining`, `approveTraining`, `instantAnswers`, `regenerateInstantAnswers`, `removeInstantAnswer` |
| `knowledgeGaps` | `list`, `answer` |
| `conversations` | `get`, `pause`, `resume`, `ownerMessage` |
| `shadowDrafts` | `list`, `send`, `discard` |
| `testChat` | `turn` |
| `whatsapp` | `status`, `pair`, `reconnect`, `reset` |
| `summary` | `weekly`, `sendWeekly` |
| `orders` | `confirm` |
| `insights` | `analyze`, `approve`, `dismiss` |

---

## 4. Next steps
- Run `/graphify . --update` so the graph matches the code. It currently lists libraries the project no longer has.
- `NotFound.tsx` is not used. Either route unknown paths to it or delete it.
- `Home.tsx` (router) and `HomePage.tsx` (landing page) have confusingly similar names.
