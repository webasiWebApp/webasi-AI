# Supabase deployment

1. Open the Supabase SQL Editor for the configured project.
2. Run [`migrations/001_initial_schema.sql`](migrations/001_initial_schema.sql) in full, then [`migrations/002_orders_and_lockdown.sql`](migrations/002_orders_and_lockdown.sql) [`migrations/003_client_behaviour.sql`](migrations/003_client_behaviour.sql) and [`migrations/004_followups_and_weekly_summary.sql`](migrations/004_followups_and_weekly_summary.sql). If the tables already exist, run only the migrations you have not applied; 002–004 are safe to re-run.
3. Confirm the tables `settings`, `projects`, `conversations`, `messages`, `event_log`, `usage_counters`, `training_sessions`, `insights`, `orders`, and `baileys_auth_state` exist.
4. Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. Set it in Render environment variables; never expose it as a `VITE_*` variable.
5. Check `/health` after deployment. It should report both Supabase and WhatsApp status.