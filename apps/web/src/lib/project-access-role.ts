// [SID:4681] (D3 · piece ② · Kadir codex · PO (나)): who may give agents access to a project they just made — the server's rule
// (`POST /projects/{id}/access`: owner · admin only; the maker gets no project_access row of their own) and the «접근 권한» screen the
// notice points to are both owner/admin only, so a member would get nothing but 403s and a dead end. The same judgment as 4656's
// `can_change` and desktop-devices' canManageDevices: the org role, nothing else. The server keeps its own gate.

/** true for an org owner or admin — the check list is drawn and grants are sent only then */
export function canGrantProjectAccess(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
