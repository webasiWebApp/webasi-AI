# Graph Report - webasi-AI  (2026-10-28)

## Corpus Check
- 106 files · ~275,915 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1011 nodes · 2323 edges · 57 communities (40 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Automation & FAQ Runtime
- Dashboard Shared UI
- LLM Providers & Failover
- Server Bootstrap & Imports
- Data Layer & Router Tests
- Follow-up Scheduler
- Conversation Processor
- CI & Uptime Workflows
- Sheet & Separator UI
- Conversation Engine
- Package Manifest
- Runtime Dependencies
- Card UI
- Dashboard Layout
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 44
- Community 45
- Community 56

## God Nodes (most connected - your core abstractions)
1. `cn()` - 73 edges
2. `hasDatabase()` - 58 edges
3. `AppRouter` - 53 edges
4. `vitest` - 31 edges
5. `recordEvent()` - 29 edges
6. `react` - 28 edges
7. `processWhatsAppMessage()` - 28 edges
8. `cn()` - 26 edges
9. `ENV` - 24 edges
10. `lucide-react` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Inbound Message Flow` --references--> `processWhatsAppMessage()`  [EXTRACTED]
  SYSTEMOVERVIEW.md → server/conversations/processor.ts
- `Credentials PDF (never stored)` --references--> `recordEvent()`  [EXTRACTED]
  webasi-pipeline-build-prompt.md → server/data/events.ts
- `Job Stage Machine (lead to closed)` --calls--> `recordEvent()`  [EXTRACTED]
  webasi-pipeline-build-prompt.md → server/data/events.ts
- `SidebarProvider()` --references--> `react`  [EXTRACTED]
  client/src/components/ui/sidebar.tsx → package.json
- `useSidebar()` --references--> `react`  [EXTRACTED]
  client/src/components/ui/sidebar.tsx → package.json

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **WhatsApp Transport Options** — baileys_md, external_notes_md, completion_notes_md [INFERRED 0.90]
- **Inbound message processing pipeline** — server_whatsapp_baileys, server_conversations_processor_processwhatsappmessage, server_conversations_faq_cache, server_conversations_engine, server_core_llm [EXTRACTED 0.95]
- **Start project atomic flow** — webasi_pipeline_build_prompt_start_project_rpc, webasi_pipeline_build_prompt_ledger, webasi_pipeline_build_prompt_task_template, webasi_pipeline_build_prompt_job_stage_machine [EXTRACTED 0.95]
- **Migration verification (README, PGlite test, CI)** — supabase_readme_migration_order, supabase_readme_pglite_migration_test, github_workflows_ci_verify_job [INFERRED 0.75]

## Communities (57 total, 17 thin omitted)

### Community 0 - "Automation & FAQ Runtime"
Cohesion: 0.06
Nodes (96): main(), runFollowUps(), weeklySummaryText(), buildFaqCache(), instantAnswersFor(), knowledgeFingerprint(), checkSupabaseConnection(), getSupabaseServer() (+88 more)

### Community 1 - "Dashboard Shared UI"
Cohesion: 0.10
Nodes (47): ClientInsightPanel(), cn(), fieldLabel(), MetricCard(), PageHeader(), SettingsSection(), signalTone, StatusDot() (+39 more)

### Community 2 - "LLM Providers & Failover"
Cohesion: 0.06
Nodes (55): answer(), providers, request, modelForProvider(), acquireRateLimit, contentToText(), GeminiContent, GeminiPart (+47 more)

### Community 3 - "Server Bootstrap & Imports"
Cohesion: 0.06
Nodes (38): compression, express, nanoid, superjson, @trpc/server, AI_PROCEDURES, callsAi(), CONTENT_SECURITY_POLICY (+30 more)

### Community 4 - "Data Layer & Router Tests"
Cohesion: 0.05
Nodes (17): answers(), holder, training(), answers, thisMonth, world, Action, DEFAULTS (+9 more)

### Community 5 - "Follow-up Scheduler"
Cohesion: 0.06
Nodes (49): buildWeeklySummary(), CHECK_INTERVAL_MS, colomboParts(), dueForFollowUp(), fallbackFollowUp(), FOLLOW_UP_AFTER_HOURS, FOLLOW_UP_BEFORE_HOURS, FollowUpCandidate (+41 more)

### Community 6 - "Conversation Processor"
Cohesion: 0.07
Nodes (30): createConversationEngine(), instantReplyText(), appendTranscript(), engineFor(), project, internalClientId(), mergeExtracted(), MessageProcessorDeps (+22 more)

### Community 7 - "CI & Uptime Workflows"
Cohesion: 0.05
Nodes (29): CI workflow (ci.yml), Merge conflict marker check, verify job (check, test, build), Uptime check workflow (uptime.yml), Health check with 3 retries, WEBASI_HEALTH_URL repository variable, public.orders, conversations_updated_at_idx (+21 more)

### Community 8 - "Sheet & Separator UI"
Cohesion: 0.08
Nodes (27): Separator(), Sheet(), SheetContent(), SheetDescription(), SheetFooter(), SheetHeader(), SheetOverlay(), SheetTitle() (+19 more)

### Community 9 - "Conversation Engine"
Cohesion: 0.08
Nodes (29): allowedNumbersCache, amount, amountFirstPattern, buildSystemPrompt(), contentToText(), ConversationEngine, ConversationTurn, currencyFirstPattern (+21 more)

### Community 10 - "Package Manifest"
Cohesion: 0.07
Nodes (29): license, name, packageManager, type, version, baseline-browser-mapping, clsx, cross-env (+21 more)

### Community 11 - "Runtime Dependencies"
Cohesion: 0.07
Nodes (29): dependencies, baileys, class-variance-authority, clsx, compression, dotenv, express, lucide-react (+21 more)

### Community 12 - "Card UI"
Cohesion: 0.13
Nodes (20): Card(), CardAction(), CardContent(), CardDescription(), CardFooter(), CardHeader(), CardTitle(), DropdownMenu() (+12 more)

### Community 13 - "Dashboard Layout"
Cohesion: 0.12
Nodes (19): menuItems, Avatar(), AvatarFallback(), AvatarImage(), Sidebar(), SidebarContent(), SidebarFooter(), SidebarHeader() (+11 more)

### Community 14 - "Community 14"
Cohesion: 0.14
Nodes (19): CANONICAL, FaqCache, FaqEntry, FaqIndex, FaqMatch, indexCache, indexFor(), Language (+11 more)

### Community 15 - "Community 15"
Cohesion: 0.10
Nodes (20): compilerOptions, allowImportingTsExtensions, baseUrl, downlevelIteration, esModuleInterop, incremental, jsx, lib (+12 more)

### Community 16 - "Community 16"
Cohesion: 0.10
Nodes (20): devDependencies, baseline-browser-mapping, cross-env, @electric-sql/pglite, esbuild, pnpm, prettier, tailwindcss (+12 more)

### Community 17 - "Community 17"
Cohesion: 0.21
Nodes (11): pauseConversationByWaId(), extractWhatsAppMessages(), closers, serve(), ParsedWhatsAppMessage, registerWhatsAppWebhook(), verifyMetaSignature(), verifyWebhookChallenge() (+3 more)

### Community 18 - "Community 18"
Cohesion: 0.16
Nodes (14): clearBaileysSession(), BaileysConnectionStatus, BaileysSendResult, BaileysStatus, canSendBaileysMessage(), createDebouncer(), INBOUND_TEXT_DEBOUNCE_MS, normalizeBaileysPhone() (+6 more)

### Community 19 - "Community 19"
Cohesion: 0.14
Nodes (13): dotenv, Case, cases, limitIndex, allowedNumbers(), unpriced, valid(), quotedAmounts() (+5 more)

### Community 20 - "Community 20"
Cohesion: 0.21
Nodes (13): projectFacts(), tidyReply(), validateReplyContent(), needsJudgement(), approvedAnswer(), buildFaqPrompt(), faqEntriesFromModel(), fingerprintCache (+5 more)

### Community 21 - "Community 21"
Cohesion: 0.20
Nodes (7): createDatabaseAuthState(), baileysStatusCode(), BaileysTransport, shouldIgnoreBaileysMessage(), startBaileysTransport(), startupFailureStatus(), waIdFromJid()

### Community 22 - "Community 22"
Cohesion: 0.15
Nodes (12): Dialog(), DialogCompositionContext, DialogContent(), DialogDescription(), DialogFooter(), DialogHeader(), DialogOverlay(), DialogTitle() (+4 more)

### Community 23 - "Community 23"
Cohesion: 0.12
Nodes (15): aliases, components, hooks, lib, ui, utils, rsc, $schema (+7 more)

### Community 24 - "Community 24"
Cohesion: 0.12
Nodes (15): WEBASI AI System Overview, Known Risks, Inbound Message Flow, Next Steps, Dashboard Sitemap, Tech Stack (TS, React 19, tRPC, Supabase), Client Pipeline, Documents and Finance build prompt, Appendix A contract wording (+7 more)

### Community 25 - "Community 25"
Cohesion: 0.17
Nodes (11): App(), DashboardLayout(), DashboardLayoutContent(), Toaster(), Theme, ThemeContext, ThemeContextType, ThemeProvider() (+3 more)

### Community 26 - "Community 26"
Cohesion: 0.19
Nodes (6): AppOptions, closers, serve(), ENV, NotificationPayload, Environment Configuration

### Community 27 - "Community 27"
Cohesion: 0.27
Nodes (8): baileys, encryptionKey(), hasBaileysSession(), open(), readState(), saveBaileysCreds(), seal(), writeState()

### Community 28 - "Community 28"
Cohesion: 0.18
Nodes (4): vitest, now, state, live

### Community 29 - "Community 29"
Cohesion: 0.29
Nodes (7): Input(), TimerResponse, useComposition(), UseCompositionOptions, UseCompositionReturn, noop, usePersistFn()

### Community 30 - "Community 30"
Cohesion: 0.31
Nodes (5): connected(), deliver(), tick(), update(), world

### Community 31 - "Community 31"
Cohesion: 0.25
Nodes (8): scripts, build, check, dev, eval, format, start, test

### Community 32 - "Community 32"
Cohesion: 0.29
Nodes (3): ErrorBoundary, Props, State

### Community 33 - "Community 33"
Cohesion: 0.38
Nodes (4): Button(), buttonVariants, class-variance-authority, @radix-ui/react-slot

### Community 34 - "Community 34"
Cohesion: 0.29
Nodes (4): queryClient, trpcClient, @tanstack/react-query, @trpc/client

### Community 35 - "Community 35"
Cohesion: 0.29
Nodes (3): @electric-sql/pglite, files, migrationsDir

### Community 37 - "Community 37"
Cohesion: 0.33
Nodes (3): @tailwindcss/vite, vite, @vitejs/plugin-react

### Community 38 - "Community 38"
Cohesion: 0.40
Nodes (4): buildCommand, outputDirectory, rewrites, version

### Community 40 - "Community 40"
Cohesion: 0.50
Nodes (4): Appendix B quotation structure, Document numbering RPC, Server-side PDF generation (pdfkit), Quotation PDF

### Community 41 - "Community 41"
Cohesion: 0.67
Nodes (3): Baileys Transport Documentation, Completion Notes, External Notes

## Knowledge Gaps
- **53 isolated node(s):** `Client Index HTML`, `pnpm Workspace Configuration`, `Visual Check`, `Baileys Transport Documentation`, `External Notes` (+48 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 379 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `Community 28` to `Dashboard Shared UI`, `LLM Providers & Failover`, `Server Bootstrap & Imports`, `Community 35`, `Follow-up Scheduler`, `Conversation Processor`, `Data Layer & Router Tests`, `Package Manifest`, `Community 14`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 26`, `Community 30`?**
  _High betweenness centrality (0.147) - this node is a cross-community bridge._
- **What connects `Client Index HTML`, `pnpm Workspace Configuration`, `Visual Check` to the rest of the system?**
  _53 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Automation & FAQ Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.06368520859671302 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Dashboard Shared UI` to `Community 32`, `Community 33`, `Sheet & Separator UI`, `Package Manifest`, `Card UI`, `Dashboard Layout`, `Community 22`, `Community 25`, `Community 29`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Should `Dashboard Shared UI` be split into smaller, more focused modules?**
  _Cohesion score 0.10303030303030303 - nodes in this community are weakly interconnected._
- **Why does `lucide-react` connect `Dashboard Shared UI` to `Community 32`, `Community 33`, `Sheet & Separator UI`, `Package Manifest`, `Card UI`, `Dashboard Layout`, `Community 22`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Should `LLM Providers & Failover` be split into smaller, more focused modules?**
  _Cohesion score 0.05683563748079877 - nodes in this community are weakly interconnected._