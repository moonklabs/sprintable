/**
 * story #4762 — the machine-readable `reason` the backend writes on a 404 of `GET /api/v2/me` (`backend/app/routers/me.py`: NO_MEMBERSHIP_REASON ·
 * MEMBERSHIP_ELSEWHERE_REASON; the envelope's code stays `NOT_FOUND`, so every other reader is unchanged).
 *
 *  · `no_membership`       the account exists and has no organization at all — a brand-new person: the onboarding is where they go.
 *  · `membership_elsewhere` the person DOES belong to an organization, but the session's token names another one (or none): a session out of step with the
 *    membership — measured on an Android phone right after sign-up (the sign-up token has no organization claim). The onboarding («create an organization»)
 *    is the wrong place for them: they could make a second organization they do not need. A new sign-in issues a token with the right claim.
 *
 * The proxy (`proxy.ts` lookupVerifiedOrg) already reads the field this way; the authenticated layout read every 404 as «no organization».
 */
export const ME_REASON_NO_MEMBERSHIP = 'no_membership';
export const ME_REASON_MEMBERSHIP_ELSEWHERE = 'membership_elsewhere';

/** the `reason` word of a `/api/v2/me` 404 body (envelope `{error:{reason}}` or FastAPI's `{detail:{reason}}`), or null when there is none / the body is unreadable */
export async function readMe404Reason(res: Pick<Response, 'json'>): Promise<string | null> {
  const body = await res.json().catch(() => null) as { error?: { reason?: unknown }; detail?: { reason?: unknown } } | null;
  const reason = body?.error?.reason ?? body?.detail?.reason;
  return typeof reason === 'string' ? reason : null;
}
