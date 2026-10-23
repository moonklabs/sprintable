// story #4714 AC2 — «Mac에서 열 링크를 메일로 받기» on the phone app's first screen (no paired Mac). The web asks once; the SERVER mails the signed-in
// person's own account address a plain link to the download page (no token · no code). Nothing goes with the call — no address, no body — so there
// is nothing here for another receiver to hide in. Every end is one outcome the card draws as one line:
// «보냈어요» only when the server says it delivered; a console fallback (`delivered:false`) is a failure, never «sent».

import { fetchWithAuth } from '@/lib/db/client';

export type MacLinkMailOutcome =
  | { kind: 'sent'; email: string }
  | { kind: 'limited' } // 429 — three an hour, one a minute, per person (the server's rule is the only one: the card counts nothing)
  | { kind: 'need_verify' } // 409 email_not_verified
  | { kind: 'not_enabled' } // 409 download_not_enabled — the screen draws nothing
  | { kind: 'failed' }; // any other end, a lost answer, and a mail that was not delivered

async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string }; code?: string };
    return body.error?.code ?? body.code ?? '';
  } catch {
    return '';
  }
}

export async function sendMacLinkMail(): Promise<MacLinkMailOutcome> {
  let res: Response;
  try {
    res = await fetchWithAuth('/api/desktop/mac-link-mail', { method: 'POST' }); // no body · no query: the receiver is the account's own address, read by the server
  } catch {
    return { kind: 'failed' };
  }
  if (res.status === 429) return { kind: 'limited' };
  if (!res.ok) {
    const code = await codeOf(res);
    if (res.status === 409 && code === 'email_not_verified') return { kind: 'need_verify' };
    if (res.status === 409 && code === 'download_not_enabled') return { kind: 'not_enabled' };
    return { kind: 'failed' };
  }
  try {
    const body = (await res.json()) as { delivered?: unknown; data?: { delivered?: unknown; email?: unknown }; email?: unknown } | null;
    const inner = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
    if (inner && typeof inner === 'object' && inner.delivered === true && typeof inner.email === 'string' && inner.email.length > 0) return { kind: 'sent', email: inner.email };
  } catch {
    // an unreadable answer is not a «sent»
  }
  return { kind: 'failed' };
}
