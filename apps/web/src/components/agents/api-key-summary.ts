// story 4912 (B1) — what an agent's key list says in ONE row (kept out of the route file: App Router page files may only export what Next allows)

export interface KeyRecord {
  id: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

// story 4912 (B1) — what a row says about the agent's keys: loading · the read FAILED (not «no key» — a failed read is not an empty list) · or how many are active / when last used / expiring within 7 days
export type KeySummary =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ok'; active: number; lastUsedAt: string | null; expiresInDays: number | null };

export function summarizeKeys(keys: KeyRecord[], now = Date.now()): Extract<KeySummary, { state: 'ok' }> {
  const active = keys.filter((k) => !k.revoked_at);
  let lastUsedAt: string | null = null;
  for (const k of active) if (k.last_used_at && (!lastUsedAt || k.last_used_at > lastUsedAt)) lastUsedAt = k.last_used_at;
  // the same rule the key line used to wear: «⚠ n일 뒤 만료» within 7 days (an already expired key is not «expiring»)
  let expiresInDays: number | null = null;
  for (const k of active) {
    if (!k.expires_at) continue;
    const days = Math.ceil((new Date(k.expires_at).getTime() - now) / (1000 * 60 * 60 * 24));
    if (days > 0 && days <= 7 && (expiresInDays === null || days < expiresInDays)) expiresInDays = days;
  }
  return { state: 'ok', active: active.length, lastUsedAt, expiresInDays };
}
