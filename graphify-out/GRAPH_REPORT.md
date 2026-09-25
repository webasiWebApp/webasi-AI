# Graph Report - webasi-AI  (2026-09-26)

## Corpus Check
- 155 files · ~64,564 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 6, .css 1, .patch 1)

## Summary
- 1195 nodes · 2484 edges · 143 communities (58 shown, 85 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 16 edges (avg confidence: 0.69)
- Token cost: 4,531 input · 838 output

## Community Hubs (Navigation)
- Accordion (62)
- Relations (41)
- Gemini (41)
- Dialog (40)
- Settings (40)
- Aichatbox (37)
- Baileys (36)
- Checkbox (33)
- Build (31)
- Manusdialog (27)
- Crypto (24)
- Home (22)
- Dashboardlayout (20)
- Express (20)
- Sidebar (19)
- Publicprocedure (19)
- Menubar (18)
- Engine (18)
- Createconversationengine (18)
- S3 (17)
- Menu (17)
- Ms (17)
- Map (17)
- Collector (16)
- Chart (16)
- Menu (16)
- Field (16)
- Components (16)
- Alert (15)
- Carousel (15)
- Form (15)
- Loc (15)
- Storage (15)
- Cookie (14)
- Buildcronuser (14)
- Add (13)
- Item (13)
- Heartbeat (13)
- App (12)
- Badge (12)
- Select (12)
- Menu (11)
- Sheet (11)
- Const (10)
- Voicetranscription (9)
- App (8)
- Group (8)
- Empty (8)
- Scripts (8)
- Oauthservice (8)
- Errorboundary (7)
- Trpc (7)
- Express (7)
- Storage (7)
- Errors (7)
- Supabasetodos (6)
- Package (6)
- Md (5)
- Dashboardlayoutskeleton (4)
- Path (4)
- Autoprefixer (2)
- Presigner (2)
- Axios (2)
- Baileys (2)
- Mapping (2)
- Loc (2)
- Clsx (2)
- Cmdk (2)
- Cookie (2)
- Fns (2)
- Dotenv (2)
- Config (2)
- Kit (2)
- Orm (2)
- React (2)
- Esbuild (2)
- Motion (2)
- Otp (2)
- Jose (2)
- React (2)
- Mysql2 (2)
- Nanoid (2)
- Pino (2)
- React (2)
- Accordion (2)
- Dialog (2)
- Avatar (2)
- Checkbox (2)
- Collapsible (2)
- Menu (2)
- Dialog (2)
- Menu (2)
- Label (2)
- Menubar (2)
- Popover (2)
- Progress (2)
- Group (2)
- Area (2)
- Select (2)
- Slider (2)
- Slot (2)
- Switch (2)
- Tabs (2)
- Toggle (2)
- Group (2)
- Tooltip (2)
- Picker (2)
- Dom (2)
- Form (2)
- Panels (2)
- Recharts (2)
- Sonner (2)
- Streamdown (2)
- Js (2)
- Superjson (2)
- Merge (2)
- Animate (2)
- Query (2)
- Client (2)
- Query (2)
- Server (2)
- Vaul (2)
- Wouter (2)
- Zod (2)
- Pnpm (2)
- Postcss (2)
- Prettier (2)
- Typography (2)
- Vite (2)
- Css (2)
- Express (2)
- Maps (2)
- Node (2)
- React (2)
- Dom (2)
- Typescript (2)
- Runtime (2)
- React (2)
- D (2)
- Html (1)
- Yaml (1)
- Md (1)

## God Nodes (most connected - your core abstractions)
1. `cn()` - 276 edges
2. `getDb()` - 33 edges
3. `getSupabaseServer()` - 32 edges
4. `ENV` - 23 edges
5. `react` - 20 edges
6. `useSupabase()` - 19 edges
7. `processWhatsAppMessage()` - 17 edges
8. `recordEvent()` - 15 edges
9. `compilerOptions` - 15 edges
10. `Button()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `CalendarDayButton()` --references--> `react`  [EXTRACTED]
  client/src/components/ui/calendar.tsx → package.json
- `useCarousel()` --references--> `react`  [EXTRACTED]
  client/src/components/ui/carousel.tsx → package.json
- `Carousel()` --references--> `react`  [EXTRACTED]
  client/src/components/ui/carousel.tsx → package.json
- `useDialogComposition()` --references--> `react`  [EXTRACTED]
  client/src/components/ui/dialog.tsx → package.json
- `Dialog()` --references--> `react`  [EXTRACTED]
  client/src/components/ui/dialog.tsx → package.json

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **WhatsApp Transport Options** — baileys_md, external_notes_md, completion_notes_md, task_md [INFERRED 0.90]

## Communities (143 total, 85 thin omitted)

### Community 0 - "Accordion (62)"
Cohesion: 0.05
Nodes (50): Accordion(), AccordionContent(), AccordionItem(), AccordionTrigger(), AspectRatio(), Avatar(), AvatarFallback(), AvatarImage() (+42 more)

### Community 1 - "Relations (41)"
Cohesion: 0.07
Nodes (36): BaileysState, Conversation, conversations, EventLog, eventLogs, InsertConversation, InsertProject, InsertUsageCounter (+28 more)

### Community 2 - "Gemini (41)"
Cohesion: 0.07
Nodes (39): contentToText(), GeminiContent, GeminiPart, GeminiResponse, invokeGemini(), modelName(), schemaFromResponseFormat(), assertApiKey() (+31 more)

### Community 3 - "Dialog (40)"
Cohesion: 0.07
Nodes (30): AlertDialogAction(), AlertDialogCancel(), AlertDialogContent(), AlertDialogDescription(), AlertDialogFooter(), AlertDialogHeader(), AlertDialogOverlay(), AlertDialogTitle() (+22 more)

### Community 4 - "Settings (40)"
Cohesion: 0.19
Nodes (36): Settings, run(), getSupabaseServer(), protectedProcedure, getDb(), activateProject(), analyzeInsights(), approveInsight() (+28 more)

### Community 5 - "Aichatbox (37)"
Cohesion: 0.09
Nodes (29): AIChatBox(), AIChatBoxProps, Message, loadMapScript(), MapView(), MapViewProps, Window, useDialogComposition() (+21 more)

### Community 6 - "Baileys (36)"
Cohesion: 0.11
Nodes (24): ref_baileys, ref_pino, ParsedWhatsAppMessage, clearBaileysSession(), createDatabaseAuthState(), deleteState(), encryptionKey(), hasBaileysSession() (+16 more)

### Community 7 - "Checkbox (33)"
Cohesion: 0.07
Nodes (23): Checkbox(), InputOTP(), InputOTPGroup(), InputOTPSlot(), Progress(), RadioGroup(), RadioGroupItem(), ResizableHandle() (+15 more)

### Community 8 - "Build (31)"
Cohesion: 0.07
Nodes (30): build, client/src/**/*, dist, dom, dom.iterable, esnext, node, node_modules (+22 more)

### Community 9 - "Manusdialog (27)"
Cohesion: 0.10
Nodes (21): ManusDialogProps, Command(), CommandDialog(), CommandEmpty(), CommandGroup(), CommandInput(), CommandItem(), CommandList() (+13 more)

### Community 10 - "Crypto (24)"
Cohesion: 0.16
Nodes (17): ref_node_crypto, ref_vitest, extractWhatsAppMessages(), registerWhatsAppWebhook(), verifyMetaSignature(), verifyWebhookChallenge(), WhatsAppMessage, WhatsAppWebhookPayload (+9 more)

### Community 11 - "Home (22)"
Cohesion: 0.15
Nodes (15): cn(), ConversationsPage(), EventsPage(), HomePage(), InsightsPage(), MetricCard(), OrdersPage(), parseConversationMessages() (+7 more)

### Community 12 - "Dashboardlayout (20)"
Cohesion: 0.14
Nodes (17): DashboardLayoutContent(), menuItems, DropdownMenuContent(), Sidebar(), SidebarContent(), SidebarFooter(), SidebarHeader(), SidebarInset() (+9 more)

### Community 13 - "Express (20)"
Cohesion: 0.17
Nodes (18): express, express, ref_dotenv_config, ref_fs, ref_http, ref_nanoid, ref_net, ref_vite (+10 more)

### Community 14 - "Sidebar (19)"
Cohesion: 0.12
Nodes (17): SidebarContext, SidebarContextProps, SidebarGroup(), SidebarGroupAction(), SidebarGroupContent(), SidebarGroupLabel(), SidebarInput(), SidebarMenuAction() (+9 more)

### Community 15 - "Publicprocedure (19)"
Cohesion: 0.15
Nodes (16): d_drive_d_avix_project_webasi_ai_webasi_ai_server_core_trpc_publicprocedure, d_drive_d_avix_project_webasi_ai_webasi_ai_server_core_trpc_router, d_drive_d_avix_project_webasi_ai_webasi_ai_shared_const_not_admin_err_msg, d_drive_d_avix_project_webasi_ai_webasi_ai_shared_const_unauthed_err_msg, ref_trpc_server, ref_zod, buildEndpointUrl(), isNonEmptyString() (+8 more)

### Community 16 - "Menubar (18)"
Cohesion: 0.11
Nodes (13): Menubar(), MenubarCheckboxItem(), MenubarContent(), MenubarItem(), MenubarLabel(), MenubarMenu(), MenubarRadioItem(), MenubarSeparator() (+5 more)

### Community 17 - "Engine (18)"
Cohesion: 0.15
Nodes (12): contentToText(), ConversationEngine, ConversationTurn, parseStructured(), responseSchema, StructuredReply, baseTurn, validateGroundedReply() (+4 more)

### Community 18 - "Createconversationengine (18)"
Cohesion: 0.22
Nodes (14): createConversationEngine(), internalClientId(), mergeExtracted(), MessageProcessorDeps, ProcessResult, processWhatsAppMessage(), textFor(), buildTextMessagePayload() (+6 more)

### Community 19 - "S3 (17)"
Cohesion: 0.12
Nodes (17): @aws-sdk/client-s3, class-variance-authority, @hookform/resolvers, next-themes, dependencies, @aws-sdk/client-s3, class-variance-authority, @hookform/resolvers (+9 more)

### Community 20 - "Menu (17)"
Cohesion: 0.12
Nodes (12): ContextMenu(), ContextMenuCheckboxItem(), ContextMenuContent(), ContextMenuItem(), ContextMenuLabel(), ContextMenuRadioItem(), ContextMenuSeparator(), ContextMenuShortcut() (+4 more)

### Community 21 - "Ms (17)"
Cohesion: 0.14
Nodes (14): d_drive_d_avix_project_webasi_ai_webasi_ai_shared_const_axios_timeout_ms, User, ref_axios, ref_jose, AuthenticatedUser, SessionPayload, AuthorizeRequest, AuthorizeResponse (+6 more)

### Community 22 - "Map (17)"
Cohesion: 0.12
Nodes (16): DirectionsResult, DistanceMatrixResult, ElevationResult, GeocodingResult, getMapsConfig(), LatLng, makeRequest(), MapsConfig (+8 more)

### Community 23 - "Collector (16)"
Cohesion: 0.25
Nodes (14): compactText(), describeElement(), elText(), formatArg(), formatArgs(), getInputValueSafe(), installUiEventListeners(), isSensitiveField() (+6 more)

### Community 24 - "Chart (16)"
Cohesion: 0.17
Nodes (14): ChartConfig, ChartContainer(), ChartContext, ChartContextProps, ChartLegendContent(), ChartTooltipContent(), getPayloadConfigFromPayload(), THEMES (+6 more)

### Community 25 - "Menu (16)"
Cohesion: 0.12
Nodes (11): DropdownMenu(), DropdownMenuCheckboxItem(), DropdownMenuItem(), DropdownMenuLabel(), DropdownMenuRadioItem(), DropdownMenuSeparator(), DropdownMenuShortcut(), DropdownMenuSubContent() (+3 more)

### Community 26 - "Field (16)"
Cohesion: 0.23
Nodes (14): Field(), FieldContent(), FieldDescription(), FieldError(), FieldGroup(), FieldLabel(), FieldLegend(), FieldSeparator() (+6 more)

### Community 27 - "Components (16)"
Cohesion: 0.12
Nodes (15): aliases, components, hooks, lib, ui, utils, rsc, $schema (+7 more)

### Community 28 - "Alert (15)"
Cohesion: 0.18
Nodes (12): Alert(), AlertDescription(), AlertTitle(), alertVariants, ToggleGroup(), ToggleGroupContext, ToggleGroupItem(), Toggle() (+4 more)

### Community 29 - "Carousel (15)"
Cohesion: 0.18
Nodes (14): Carousel(), CarouselApi, CarouselContent(), CarouselContext, CarouselContextProps, CarouselItem(), CarouselNext(), CarouselOptions (+6 more)

### Community 30 - "Form (15)"
Cohesion: 0.19
Nodes (12): FormControl(), FormDescription(), FormFieldContext, FormFieldContextValue, FormItemContext, FormItemContextValue, FormLabel(), FormMessage() (+4 more)

### Community 31 - "Loc (15)"
Cohesion: 0.15
Nodes (13): ref_builder_io_vite_plugin_jsx_loc, ref_node_fs, ref_node_path, ref_tailwindcss_vite, ref_vite_plugin_manus_runtime, ref_vitejs_plugin_react, ensureLogDir(), LOG_DIR (+5 more)

### Community 32 - "Storage (15)"
Cohesion: 0.17
Nodes (7): ref_server_storage, DataApiCallOptions, ENV, GenerateImageOptions, GenerateImageResponse, ImageModelInfo, ListImageModelsResponse

### Community 33 - "Cookie (14)"
Cohesion: 0.22
Nodes (10): ref_cookie, ref_express, getSessionCookieOptions(), isSecureRequest(), LOCAL_HOSTS, getQueryParam(), registerOAuthRoutes(), sdk (+2 more)

### Community 34 - "Buildcronuser (14)"
Cohesion: 0.23
Nodes (4): buildCronUser(), isNonEmptyString(), SDKServer, ForbiddenError()

### Community 35 - "Add (13)"
Cohesion: 0.15
Nodes (13): add, cross-env, devDependencies, add, cross-env, tailwindcss, tsx, vite (+5 more)

### Community 36 - "Item (13)"
Cohesion: 0.18
Nodes (12): Item(), ItemActions(), ItemContent(), ItemDescription(), ItemFooter(), ItemGroup(), ItemHeader(), ItemMedia() (+4 more)

### Community 37 - "Heartbeat (13)"
Cohesion: 0.28
Nodes (12): buildEndpoint(), callForge(), createHeartbeatJob(), deleteHeartbeatJob(), HeartbeatJob, HeartbeatJobInfo, HeartbeatJobUpdate, listHeartbeatJobs() (+4 more)

### Community 38 - "App (12)"
Cohesion: 0.20
Nodes (9): Toaster(), TooltipProvider(), Theme, ThemeContext, ThemeContextType, ThemeProvider(), ThemeProviderProps, ref_next_themes (+1 more)

### Community 39 - "Badge (12)"
Cohesion: 0.18
Nodes (10): Badge(), badgeVariants, Breadcrumb(), BreadcrumbEllipsis(), BreadcrumbItem(), BreadcrumbLink(), BreadcrumbList(), BreadcrumbPage() (+2 more)

### Community 40 - "Select (12)"
Cohesion: 0.17
Nodes (10): Select(), SelectContent(), SelectItem(), SelectLabel(), SelectScrollDownButton(), SelectScrollUpButton(), SelectSeparator(), SelectTrigger() (+2 more)

### Community 41 - "Menu (11)"
Cohesion: 0.20
Nodes (10): NavigationMenu(), NavigationMenuContent(), NavigationMenuIndicator(), NavigationMenuItem(), NavigationMenuLink(), NavigationMenuList(), NavigationMenuTrigger(), navigationMenuTriggerStyle (+2 more)

### Community 42 - "Sheet (11)"
Cohesion: 0.18
Nodes (8): Sheet(), SheetContent(), SheetDescription(), SheetFooter(), SheetHeader(), SheetOverlay(), SheetTitle(), SheetTrigger()

### Community 43 - "Const (10)"
Cohesion: 0.27
Nodes (8): startLogin(), useAuth(), UseAuthOptions, d_drive_d_avix_project_webasi_ai_webasi_ai_shared_const_cookie_name, d_drive_d_avix_project_webasi_ai_webasi_ai_shared_const_oauth_state_cookie, d_drive_d_avix_project_webasi_ai_webasi_ai_shared_const_one_year_ms, ref_trpc_client, encodeOAuthState()

### Community 44 - "Voicetranscription (9)"
Cohesion: 0.28
Nodes (8): getFileExtension(), getLanguageName(), transcribeAudio(), TranscribeOptions, TranscriptionError, TranscriptionResponse, WhisperResponse, WhisperSegment

### Community 45 - "App (8)"
Cohesion: 0.25
Nodes (7): App(), queryClient, trpcClient, d_drive_d_avix_project_webasi_ai_webasi_ai_client_src_index_css, ref_react_dom_client, ref_superjson, ref_tanstack_react_query

### Community 46 - "Group (8)"
Cohesion: 0.32
Nodes (6): ButtonGroup(), ButtonGroupSeparator(), ButtonGroupText(), buttonGroupVariants, Separator(), ref_radix_ui_react_separator

### Community 47 - "Empty (8)"
Cohesion: 0.29
Nodes (7): Empty(), EmptyContent(), EmptyDescription(), EmptyHeader(), EmptyMedia(), emptyMediaVariants, EmptyTitle()

### Community 48 - "Scripts (8)"
Cohesion: 0.25
Nodes (8): scripts, build, check, db:push, dev, format, start, test

### Community 49 - "Oauthservice (8)"
Cohesion: 0.32
Nodes (3): OAuthService, ExchangeTokenResponse, GetUserInfoResponse

### Community 50 - "Errorboundary (7)"
Cohesion: 0.29
Nodes (3): ErrorBoundary, Props, State

### Community 51 - "Trpc (7)"
Cohesion: 0.33
Nodes (4): trpc, statusCopy, ref_qrcode_react, ref_trpc_react_query

### Community 52 - "Express (7)"
Cohesion: 0.33
Nodes (4): ref_trpc_server_adapters_express, AuthenticatedUser, CookieCall, TrpcContext

### Community 53 - "Storage (7)"
Cohesion: 0.57
Nodes (6): appendHashSuffix(), getForgeConfig(), normalizeKey(), storageGet(), storageGetSignedUrl(), storagePut()

### Community 55 - "Supabasetodos (6)"
Cohesion: 0.40
Nodes (3): Todo, supabase, ref_supabase_supabase_js

### Community 56 - "Package (6)"
Cohesion: 0.33
Nodes (5): license, name, packageManager, type, version

### Community 57 - "Md (5)"
Cohesion: 0.40
Nodes (5): Baileys Transport Documentation, Completion Notes, External Notes, Supabase Setup Guide, Task List

### Community 59 - "Path (4)"
Cohesion: 0.50
Nodes (3): ref_path, ref_vitest_config, templateRoot

## Knowledge Gaps
- **279 isolated node(s):** `UseAuthOptions`, `AIChatBoxProps`, `menuItems`, `Props`, `State` (+274 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 404 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **85 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `S3 (17)` to `Express (20)`, `Chart (16)`, `Package (6)`, `Presigner (2)`, `Axios (2)`, `Baileys (2)`, `Clsx (2)`, `Cmdk (2)`, `Cookie (2)`, `Fns (2)`, `Dotenv (2)`, `Orm (2)`, `React (2)`, `Motion (2)`, `Otp (2)`, `Jose (2)`, `React (2)`, `Mysql2 (2)`, `Nanoid (2)`, `Pino (2)`, `React (2)`, `Accordion (2)`, `Dialog (2)`, `Avatar (2)`, `Checkbox (2)`, `Collapsible (2)`, `Menu (2)`, `Dialog (2)`, `Menu (2)`, `Label (2)`, `Menubar (2)`, `Popover (2)`, `Progress (2)`, `Group (2)`, `Area (2)`, `Select (2)`, `Slider (2)`, `Slot (2)`, `Switch (2)`, `Tabs (2)`, `Toggle (2)`, `Group (2)`, `Tooltip (2)`, `Picker (2)`, `Dom (2)`, `Form (2)`, `Panels (2)`, `Recharts (2)`, `Sonner (2)`, `Streamdown (2)`, `Js (2)`, `Superjson (2)`, `Merge (2)`, `Animate (2)`, `Query (2)`, `Client (2)`, `Query (2)`, `Server (2)`, `Vaul (2)`, `Wouter (2)`, `Zod (2)`?**
  _High betweenness centrality (0.295) - this node is a cross-community bridge._
- **Why does `cn()` connect `Field (16)` to `Accordion (62)`, `Dialog (40)`, `Aichatbox (37)`, `Checkbox (33)`, `Manusdialog (27)`, `Dashboardlayout (20)`, `Sidebar (19)`, `Menubar (18)`, `Menu (17)`, `Chart (16)`, `Menu (16)`, `Alert (15)`, `Carousel (15)`, `Form (15)`, `Item (13)`, `Badge (12)`, `Select (12)`, `Menu (11)`, `Sheet (11)`, `Group (8)`, `Empty (8)`, `Errorboundary (7)`, `Dashboardlayoutskeleton (4)`?**
  _High betweenness centrality (0.202) - this node is a cross-community bridge._
- **Why does `react` connect `Chart (16)` to `Dialog (40)`, `Aichatbox (37)`, `Checkbox (33)`, `Manusdialog (27)`, `Dashboardlayout (20)`, `S3 (17)`, `Alert (15)`, `Carousel (15)`, `Form (15)`?**
  _High betweenness centrality (0.164) - this node is a cross-community bridge._
- **What connects `UseAuthOptions`, `AIChatBoxProps`, `menuItems` to the rest of the system?**
  _279 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Accordion (62)` be split into smaller, more focused modules?**
  _Cohesion score 0.05182443151771549 - nodes in this community are weakly interconnected._
- **Should `Relations (41)` be split into smaller, more focused modules?**
  _Cohesion score 0.06951219512195123 - nodes in this community are weakly interconnected._
- **Should `Gemini (41)` be split into smaller, more focused modules?**
  _Cohesion score 0.07195121951219512 - nodes in this community are weakly interconnected._