/**
 * story 4847 — «no project at all»: the person has no project, none is being resolved from the address, and none is picked. One rule for the three places that speak to
 * that person (the list's empty state · the right-hand outlet · the «새 대화» button), the same condition the layout used to stop on (story #4762 AC2) — so a moment where the shell
 * has not yet told the person's projects (a path project still resolving · the organization of the address not yet the token's — `orgSyncPending`) is not mistaken for «none».
 */
export function isNoProjectAtAll(ctx: { projectId?: string | null; projectMemberships: readonly unknown[]; projectPathUnresolved?: boolean; orgSyncPending?: boolean }): boolean {
  return !ctx.projectId && !ctx.projectPathUnresolved && !ctx.orgSyncPending && ctx.projectMemberships.length === 0;
}

/**
 * story 4891 — the person's projects could not be read (the request failed) and nothing else names a project: neither «none» nor a project to work in. Only the Recruit tab (Add agent)
 * tells this apart. The chats surfaces keep treating it as before (the list's empty state · «새 대화» · the compose address): changing what `isNoProjectAtAll` means moved a gap into each
 * of them (the new-conversation window, the compose address…) — recorded as its own defect, not widened here.
 */
export function projectsUnknownBecauseFailed(ctx: { projectId?: string | null; projectMemberships: readonly unknown[]; projectMembershipsFailed?: boolean }): boolean {
  return !!ctx.projectMembershipsFailed && !ctx.projectId && ctx.projectMemberships.length === 0;
}
