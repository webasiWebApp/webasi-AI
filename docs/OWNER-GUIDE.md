# WEBASI: owner guide for the client pipeline

How to set up and use the Today, Pipeline, Calendar and Finance pages. Everything here is for you alone: there are no accounts.

## 1. First setup

### Apply the two new database files
In the Supabase SQL Editor, run these in order (each is safe to run twice):
1. `supabase/migrations/20261029_jobs_documents_ledger.sql`
2. `supabase/migrations/20261030_renewals_reminders.sql`

Until you do, the new pages show an error and the AI assistant carries on as before.

### Set the PIN
The dashboard asks for a PIN before it shows anything. Set two environment variables on the server (on Render: *Environment*, then redeploy):

| Variable | What to put |
|---|---|
| `DASHBOARD_PIN` | The PIN you will type, for example `482915`. Use at least 6 digits. |
| `JWT_SECRET` | A long random string. It signs the login cookie. Anyone with it could forge a login, so keep it private. |

- Without `DASHBOARD_PIN` or `JWT_SECRET`, a production server answers **503** and shows nothing except the health checks. That is on purpose.
- Open the dashboard, type the PIN, press Unlock. You stay signed in for 7 days. **Lock dashboard** (the padlock on a phone, the menu at the bottom of the sidebar on a computer) signs you out now.
- Five wrong PINs from one address lock that address out for a minute, then longer with each further miss.
- To change the PIN, change the variable and redeploy: everyone is signed out.
- The old `DASHBOARD_PASSWORD` no longer does anything. Delete it.

### Fill in Settings
Open **Settings** and scroll to **Business documents**:
- **Registration no.** is printed top right on every quotation, invoice and receipt.
- **Next document number** is the next number that will be issued (09248 to begin with). It only moves forward.
- **Default advance %** (40) starts every new quotation.
- The wording of Infrastructure, After service, Timeline, Portfolio and the footer links starts every quotation. You can still change them for one quotation.
- **Contract and NDA wording** holds the clauses from your template exactly as written.

**Template review needed.** Your contract template has three things that disagree with each other. They are kept as written and a notice shows in Settings and on the contract form until you dismiss it:
1. The opening line says "[Start Date] – [30 days after delivery]". It does not say what the end date means. "[Start Date]" is filled in; "[30 days after delivery]" prints as written until you edit the line.
2. The contract warranty is 30 days, while the quotation promises 1 year of free support. They are separate clauses.
3. The template's example payment split is 50/50. The contract always takes the real split from the approved quotation.

### Optional: Google Calendar sync
The built-in calendar works on its own. To also put meetings in your Google Calendar (free):
1. In Google Cloud Console create a project, enable the **Google Calendar API**, then create a **service account** and a **JSON key** for it. Download the key file.
2. Open your Google Calendar settings, share the calendar with the service account's e-mail address (it looks like `name@project.iam.gserviceaccount.com`) with the permission **Make changes to events**.
3. Turn the key file into one line of text: on a computer with Git Bash, `base64 -w0 your-key.json`.
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to that text and `GOOGLE_CALENDAR_ID` to the calendar's address (for your main calendar, your Gmail address). Redeploy.

A meeting always saves first. Its badge then shows **On Google**, **Syncing** or **Sync failed**; a failed one retries by itself a few times, and there is a **Retry sync** button. Zoom or Meet links cannot be created automatically; paste one into the meeting's location.

## 2. The workflow, one client at a time

1. **Create job.** From **Pipeline**, or press **Create job** on a conversation (the name and number come from the chat). The job starts as a **Lead**.
2. **Meeting** (optional). Add one on the job's Meetings tab or on the Calendar. The job moves to **Meeting**.
3. **Quotation.** Documents tab, **Quotation**. You type the client, project, intro and prices yourself. Download the PDF, send it on WhatsApp, then press **Mark as sent**. The job is **Quoted**.
4. **Client said yes.** On the sent quotation press **Client approved**. The price and payment split now come from that quotation, and the others are replaced. The job is **Approved**. (Made a mistake? **Revoke approval** on the Overview tab, until the project starts.)
5. **Contract.** **Proposal & contract pack** appears once the job is approved. Check the dates and wording, download, send.
6. **Start project.** Overview tab. Record the **full** advance. This records the payment, creates the 16-task checklist and starts the job. You cannot enter less than the agreed advance. Pressing it twice does no harm.
7. **Work.** Tick tasks on the Tasks tab. Record costs (hosting, a freelancer) on the Money tab. Make an **invoice** for the advance if the client wants one.
8. **Mark delivered.** Creates renewal reminders for hosting, domain and support, one year on. Unfinished tasks only produce a warning.
9. **Get paid.** Money tab, **Record payment**, then **Make receipt**. When the balance is zero, **Close job**.
10. **Hand over logins.** Documents tab, **Credentials PDF**. Type the logins; they go into the PDF and are not saved anywhere. If money is still owed you must tick a box to continue, and that is noted.

**Lost a client?** **Mark lost** (only before the project starts). **Reopen** brings it back to the stage it was in.

## 3. Money

- Money can only be recorded once the project has started. Company expenses (internet, subscriptions, ads, your own salary) need no job: **Finance**, **Company expense**.
- **Nothing is ever deleted.** A wrong entry is **voided** with a reason; it stays visible, counts nowhere, and its receipt is stamped VOID. Then enter the right one.
- **Outstanding** is the price minus advance and final payments. Extra work and renewals are paid on top and do not reduce it.
- Company profit = income − project costs − company costs. **Export CSV** gives the ledger for the month or all time.

## 4. Reminders to you on WhatsApp
Sent between 09:00 and 20:00, one short line each, never twice:
- a quotation marked as sent with no answer for 3 days;
- a delivered job with a balance unpaid for 3 days;
- a renewal 30 days before it is due, and again 7 days before.

Change the number of days or switch each off in **Settings, Reminders and categories**. These run only on a server that stays on (Render), not on Vercel. They are not sent to clients.

## 5. Changing the templates
- **Task list**: Settings, **Task template**. Add, rename, reorder, remove, then Save. Jobs that already started keep their own list.
- **Document wording and defaults**: Settings, **Business documents**.
- **Expense categories**: Settings, **Reminders and categories**. Income categories are fixed (advance, final, renewal, extra) because the finance totals depend on them.
- **Logo and fonts** are files in `server/documents/` (`assets/logo.png`, `fonts/`). Replace them in the repository and redeploy.
- To check how a change to the PDF layout looks: `pnpm pdf:preview ./out` writes one sample of each document.

## 6. If something looks wrong
- **"The database is not configured" or "relation does not exist"**: the two SQL files in section 1 have not been run.
- **A PDF shows "?" instead of letters**: the font covers Latin, Greek and Cyrillic, not Sinhala or Tamil.
- **Sync failed** on a meeting: read the message on the badge; check the calendar is shared with the service account, then press Retry sync.
- **The PIN screen does not accept the right PIN**: after repeated misses an address is locked out for a while; wait and try again.
