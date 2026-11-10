import { backendFetch } from '@/lib/backend-fetch';
import { fastapiBaseUrl } from '@/lib/fastapi-url';

// story 4832 — «this account's e-mail is not verified yet», read with the person's OWN session (their access token) from the account endpoint the
// verify gate also reads. The same rule as the gate (`gateClosed`): only an explicit «required» AND an explicit «not verified» — an unreadable answer,
// a missing field or a slow backend is «no line», never a wrong one. Nothing here can stop a page: it answers a boolean and never throws.
// The call goes through the shared `backendFetch` (the BFF ratchet of story #4320: a bounded signal, a timeout comes back as a 503 envelope) —
// a page render has no request to cancel with, so `request: null`; the time limit is short because the card must not wait on this line.
const READ_MS = 3000;

export async function emailUnverified(accessToken: string): Promise<boolean> {
  try {
    const res = await backendFetch(`${fastapiBaseUrl()}/api/v2/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      request: null,
      timeoutMs: READ_MS,
    });
    if (!res.ok) return false;
    const me = (await res.json()) as { email_verified?: boolean | null; email_verification_required?: boolean | null } | null;
    return me?.email_verification_required === true && me?.email_verified === false;
  } catch {
    return false;
  }
}
