import crypto from "node:crypto";

// Google Calendar over its REST API with a service account, and no SDK. A service account has no refresh token to expire
// (a user token for an app in "Testing" mode dies after 7 days); the owner shares his calendar with the account's e-mail
// ("Make changes to events"). Meet links are out of scope: a service account cannot create them, so the meeting's
// free-text link field carries a Zoom or Meet link pasted by hand.
const SCOPE = "https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";

export type GoogleConfig = { clientEmail: string; privateKey: string; tokenUri: string; calendarId: string };
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

export function readGoogleConfig(env: Record<string, string | undefined> = process.env): GoogleConfig | null {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const calendarId = env.GOOGLE_CALENDAR_ID?.trim();
  if (!raw || !calendarId) return null;
  try {
    const parsed = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    if (!parsed.client_email || !parsed.private_key) return null;
    return { clientEmail: parsed.client_email, privateKey: String(parsed.private_key).replace(/\\n/g, "\n"), tokenUri: parsed.token_uri || "https://oauth2.googleapis.com/token", calendarId };
  } catch { return null; }
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export function signServiceAccountJwt(config: GoogleConfig, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: config.clientEmail, scope: SCOPE, aud: config.tokenUri, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(config.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

let cachedToken: { value: string; expiresAt: number; email: string } | null = null;
export function resetGoogleTokenCache() { cachedToken = null; }

async function accessToken(config: GoogleConfig, fetchFn: FetchLike, now = Date.now()) {
  if (cachedToken && cachedToken.email === config.clientEmail && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;
  const response = await fetchFn(config.tokenUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signServiceAccountJwt(config, Math.floor(now / 1000)) }).toString() });
  if (!response.ok) throw new GoogleError(response.status, `Google sign-in failed (${response.status}). Check the service account key.`);
  const body = await response.json();
  cachedToken = { value: body.access_token, expiresAt: now + Number(body.expires_in ?? 3600) * 1000, email: config.clientEmail };
  return cachedToken.value;
}

// A hung connection must not hang the dashboard's save, so every call has a deadline.
const defaultFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) });

export class GoogleError extends Error { constructor(readonly status: number, message: string) { super(message); } }

// Google event ids use the characters a-v and 0-9. A SHA-1 in hex is a valid id and the same meeting always gets the
// same one, so a retry updates the event instead of creating a second.
export const eventIdFor = (meetingId: string) => crypto.createHash("sha1").update(`webasi-meeting:${meetingId}`).digest("hex");

export type CalendarMeeting = { id: string; title: string; startsAt: string; endsAt: string; locationOrLink: string; notes: string; clientName?: string; jobTitle?: string };

function eventBody(meeting: CalendarMeeting, id: string) {
  const description = [meeting.clientName && `Client: ${meeting.clientName}`, meeting.jobTitle && `Job: ${meeting.jobTitle}`, meeting.notes].filter(Boolean).join("\n");
  return { id, summary: meeting.title, description, location: meeting.locationOrLink, start: { dateTime: new Date(meeting.startsAt).toISOString(), timeZone: "Asia/Colombo" }, end: { dateTime: new Date(meeting.endsAt).toISOString(), timeZone: "Asia/Colombo" } };
}

async function call(config: GoogleConfig, fetchFn: FetchLike, method: string, path: string, body?: unknown) {
  const token = await accessToken(config, fetchFn);
  return fetchFn(`${API}/calendars/${encodeURIComponent(config.calendarId)}/events${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const fail = async (response: { status: number; text(): Promise<string> }, what: string) => { throw new GoogleError(response.status, `Google Calendar ${what} failed (${response.status}): ${(await response.text().catch(() => "")).slice(0, 200)}`); };

// Creates or updates the event. Update first (the event usually exists from an earlier save or attempt); create it when
// Google says it is not there. Either way the id is fixed, so repeating the call never makes a duplicate.
export async function upsertEvent(config: GoogleConfig, meeting: CalendarMeeting, fetchFn: FetchLike = defaultFetch): Promise<string> {
  const id = eventIdFor(meeting.id);
  const body = eventBody(meeting, id);
  const updated = await call(config, fetchFn, "PUT", `/${id}`, body);
  if (updated.ok) return id;
  if (updated.status !== 404) return fail(updated, "update");
  const created = await call(config, fetchFn, "POST", "", body);
  if (created.ok) return id;
  if (created.status === 409) { // created in between by a parallel attempt
    const again = await call(config, fetchFn, "PUT", `/${id}`, body);
    if (again.ok) return id;
    return fail(again, "update");
  }
  return fail(created, "create");
}

// Cancelling removes the event. Gone already (404 or 410) counts as done.
export async function deleteEvent(config: GoogleConfig, meetingId: string, fetchFn: FetchLike = defaultFetch) {
  const response = await call(config, fetchFn, "DELETE", `/${eventIdFor(meetingId)}`);
  if (response.ok || response.status === 404 || response.status === 410) return;
  await fail(response, "delete");
}
