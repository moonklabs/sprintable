// story 4712 — the ONE place the one-time hand-off code of «브라우저 이어받기» is made (used by the JSON route and by the form route, so the two
// can never differ): the per-person limit, the existing internal issue call for the app's PKCE challenge, and the return page's address.
// Who the code is for comes from the SESSION (the caller passes `user_id`), where it may go is the fixed table (`custom_scheme` and the fixed return uri) —
// nothing in a request body reaches the issue call except the challenge.
import { expectedReturnUri } from '@/lib/auth/oauth-callback-mode';
import { continueReturnPath, type ContinueStart } from '@/lib/auth/desktop-continue';
import { overContinueLimit } from '@/lib/auth/desktop-continue-limit';
import { BFF_BACKEND_EXTERNAL_CHAIN_TIMEOUT_MS } from '@/lib/backend-signal';
import { backendFetch } from '@/lib/backend-fetch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
const APP_LINK_ORIGIN = () => process.env['MOBILE_APP_LINK_ORIGIN'] ?? 'https://dev-app.sprintable.ai';

export type ContinueIssue = { ok: true; url: string } | { ok: false; status: 429 | 502; code: 'RATE_LIMITED' | 'ISSUE_FAILED' };

export async function issueContinueCode(userId: string, start: ContinueStart): Promise<ContinueIssue> {
  if (overContinueLimit(userId, Date.now())) return { ok: false, status: 429, code: 'RATE_LIMITED' };

  const internalSecret = process.env['FIREBASE_BFF_INTERNAL_SECRET'];
  const issueRes = await backendFetch(`${FASTAPI_URL()}/api/v2/internal/auth/oauth-handoff/issue`, {
    // 한 번 쓰는 로그인 코드 발급(story #4320 같은 꼴) — 브라우저가 끊어도 끝까지, 시간 제한만
    timeLimitOnly: true, timeoutMs: BFF_BACKEND_EXTERNAL_CHAIN_TIMEOUT_MS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(internalSecret ? { Authorization: `Bearer ${internalSecret}` } : {}) },
    body: JSON.stringify({
      user_id: userId,
      code_challenge: start.challenge,
      callback_mode: 'custom_scheme',
      return_uri: expectedReturnUri('custom_scheme', APP_LINK_ORIGIN()),
    }),
  }).catch(() => null);
  if (!issueRes || !issueRes.ok) return { ok: false, status: 502, code: 'ISSUE_FAILED' };
  const issued = (await issueRes.json().catch(() => null)) as { code?: unknown } | null;
  if (!issued || typeof issued.code !== 'string' || issued.code.length === 0) return { ok: false, status: 502, code: 'ISSUE_FAILED' };

  return { ok: true, url: continueReturnPath(issued.code, start.returnApp) };
}
