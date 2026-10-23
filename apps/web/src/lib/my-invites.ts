import { fetchWithAuth } from '@/lib/db/client';

/**
 * Pending invites to the signed-in person's own verified e-mail (GET /api/invites/mine · 4833) — no token: accepting stays the mail link.
 * Shared by story 4715's web first screen and story 4711's app setup (PO 2026-10-16: one place, the first PR in makes it). The name is
 * the one PR 5121 gave its copy in `components/desktop/desktop-setup.tsx` — whichever lands second keeps this file and drops that copy.
 */
export interface MyInvite { invite_id: string; org_id: string; org_name: string; role: string; expires_at: string }

/**
 * The person's pending invites. Throws when they cannot be read (not ok · no list) — the caller then makes no organization (rule 4832:
 * an organization is never made while the invites are unknown; an invited person would end up in a second organization of their own).
 */
export async function fetchMyInvites(): Promise<MyInvite[]> {
  const res = await fetchWithAuth('/api/invites/mine');
  if (!res.ok) throw new Error(String(res.status));
  const body = await res.json();
  // the contract's one shape (backend schemas/invite_accept.py MyInvitesResponse: `{ invites: [...] }`, no envelope) — anything else
  // is «cannot be read», never guessed (scripts/verify_web_api_response_shapes.py)
  const list: unknown = body?.invites;
  if (!Array.isArray(list)) throw new Error('no list');
  return list as MyInvite[];
}
