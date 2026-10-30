# Supabase deployment

1. Open the Supabase SQL Editor for the configured project.
2. Run the files in `migrations/` in name order:
   1. [`001_initial_schema.sql`](migrations/001_initial_schema.sql)
   2. [`002_orders_and_lockdown.sql`](migrations/002_orders_and_lockdown.sql)
   3. [`003_client_behaviour.sql`](migrations/003_client_behaviour.sql)
   4. [`004_followups_and_weekly_summary.sql`](migrations/004_followups_and_weekly_summary.sql)
   5. [`20261002_increment_usage_rpc.sql`](migrations/20261002_increment_usage_rpc.sql)
   6. [`20261004_knowledge_gaps.sql`](migrations/20261004_knowledge_gaps.sql)
   7. [`20261011_atomic_writes_and_indexes.sql`](migrations/20261011_atomic_writes_and_indexes.sql)
   8. [`20261029_jobs_documents_ledger.sql`](migrations/20261029_jobs_documents_ledger.sql) (the client pipeline: jobs, meetings, tasks, documents, ledger; the finance rules live here as constraints and triggers)
   9. [`20261030_renewals_reminders.sql`](migrations/20261030_renewals_reminders.sql) (renewals and the reminder log)

   If the tables already exist, run only the files you have not applied; everything from 002 onwards is safe to re-run.
   Items 5 to 7 are optional for the server to work: without them it falls back to slower read-then-write paths
   and has no indexes for its repeated queries. With them, usage counters, transcript updates and project switching
   happen in single database steps.
3. Confirm the tables `settings`, `projects`, `conversations`, `messages`, `event_log`, `usage_counters`, `training_sessions`, `insights`, `orders`, `knowledge_gaps`, `baileys_auth_state`, `jobs`, `meetings`, `task_templates`, `job_tasks`, `documents`, `ledger_entries`, `renewals` and `reminder_log` exist.
4. Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. Set it in Render environment variables; never expose it as a `VITE_*` variable.
5. Check `/health` after deployment. It should report both Supabase and WhatsApp status.

`pnpm test` applies every file in `migrations/` to a Postgres running inside the test process (PGlite), so a file that
does not apply cleanly, or a database function that misbehaves, fails the test run before it reaches the hosted database.
