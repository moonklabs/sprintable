/**
 * story 4847 — «no project at all»: the person has no project, none is being resolved from the address, and none is picked. One rule for the three places that speak to
 * that person (the list's empty state · the right-hand outlet · the «새 대화» button), the same condition the layout used to stop on (story #4762 AC2) — so a moment where the shell
 * has not yet told the person's projects (a path project still resolving · the organization of the address not yet the token's — `orgSyncPending`) is not mistaken for «none».
 */
export function isNoProjectAtAll(ctx: { projectId?: string | null; projectMemberships: readonly unknown[]; projectPathUnresolved?: boolean; orgSyncPending?: boolean; projectMembershipsFailed?: boolean }): boolean {
  // story 4891: a failed projects request leaves `projectMemberships` empty too — then the person's projects are UNKNOWN, not none
  return !ctx.projectId && !ctx.projectPathUnresolved && !ctx.orgSyncPending && !ctx.projectMembershipsFailed && ctx.projectMemberships.length === 0;
}
