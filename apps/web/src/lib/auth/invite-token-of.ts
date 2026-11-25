/** story 5023 — the invitation token inside a `next` that points at the invitation page (`/invite/accept?token=…`); anything else is no token. Read the way the page reads it: this site's own path only. */
export function inviteTokenOf(next: string | null): string | null {
  // this site's own path only: ONE leading slash — never `//host/…`, an absolute URL, a relative `invite/…` (those would be read against the stand-in base below and look like ours) or a backslash
  if (!next || !/^\/(?![/\\])/.test(next) || next.includes('\\')) return null;
  try {
    const u = new URL(next, 'http://invite.invalid');
    if (u.origin !== 'http://invite.invalid' || u.pathname !== '/invite/accept') return null;
    const t = u.searchParams.get('token');
    return t && t.length <= 200 && /^[A-Za-z0-9_.~-]+$/.test(t) ? t : null;
  } catch {
    return null;
  }
}
