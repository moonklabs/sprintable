// [SID:4680] (Yuna §N · §N-2) the one place that decides what a plan-limit banner says — for the three limits that stop a person making something
// (organization · project · agent) — and whether it may point at the billing tab.
//   billing open (isEEEnabled() — the deployment shows the billing tab): the title «업그레이드가 필요해요» + the reason (the plan's limit and what to do) + the way
//     `/settings?tab=billing` («요금제 업그레이드 →»).
//   billing closed (prod today): that tab is an empty pane there, and there is no «contact us» either — so no way, no «upgrade» ask: the title says the fact
//     («한도에 도달했어요») and the reason is the limit alone. Opens by itself the day billing opens (the one switch is isEEEnabled()).
// A limit of 0 is its own sentence («무료 플랜에서는 에이전트를 만들 수 없어요.») — «0개까지» and «모두 만들었어요» would both be untrue.
export type LimitResource = 'org' | 'project' | 'agent';

export interface LimitCopyInput {
  resource: LimitResource;
  /** the server's number (a whole number 0…9999) — null when the answer carries none: no number is made up */
  limit: number | null;
  /** tier free or not named — any other named tier is paid */
  free: boolean;
  /** isEEEnabled() — the billing tab exists in this deployment */
  billingOpen: boolean;
}

export interface LimitCopy {
  /** `nav` keys */
  title: 'orgLimitBannerTitle' | 'orgLimitBannerTitleClosed';
  /** the reason line: its translator namespace · key · whether it takes `{limit}`; null = no reason line (paid tier, no number, billing open: no word was given) */
  reason: { ns: 'onboarding' | 'recruiter'; key: string; withLimit: boolean } | null;
  /** «요금제 업그레이드 →» is drawn */
  link: boolean;
}

type Kind = 'exceeded' | 'exceededClosed' | 'zero' | 'zeroClosed' | 'paid' | 'noCount' | 'noCountClosed';

/**
 * The message key of every line a limit banner can say, written out one by one as a data catalog (`labelKey: '…'` — the form the dead-key guard reads as
 * «used»): `exceeded` = «…{limit}개까지 만들 수 있어요. + the upgrade ask» · `exceededClosed` = the same without the ask · `zero`/`zeroClosed` = «…만들 수 없어요.»
 * · `noCount*` = the agent line when the answer carries no number · `paid` = the paid tier's line. The namespace is the resource's own.
 */
const CATALOG: ReadonlyArray<{ resource: LimitResource; kind: Kind; labelKey: string }> = [
  { resource: 'org', kind: 'exceeded', labelKey: 'orgLimitExceededError' },
  { resource: 'org', kind: 'exceededClosed', labelKey: 'orgLimitExceededClosed' },
  { resource: 'org', kind: 'zero', labelKey: 'orgLimitZero' },
  { resource: 'org', kind: 'zeroClosed', labelKey: 'orgLimitZeroClosed' },
  { resource: 'project', kind: 'exceeded', labelKey: 'projectLimitExceededError' },
  { resource: 'project', kind: 'exceededClosed', labelKey: 'projectLimitExceededClosed' },
  { resource: 'project', kind: 'zero', labelKey: 'projectLimitZero' },
  { resource: 'project', kind: 'zeroClosed', labelKey: 'projectLimitZeroClosed' },
  { resource: 'project', kind: 'paid', labelKey: 'projectLimitExceededPaid' },
  { resource: 'agent', kind: 'exceeded', labelKey: 'agentLimitExceededError' },
  { resource: 'agent', kind: 'exceededClosed', labelKey: 'agentLimitExceededClosed' },
  { resource: 'agent', kind: 'zero', labelKey: 'agentLimitZero' },
  { resource: 'agent', kind: 'zeroClosed', labelKey: 'agentLimitZeroClosed' },
  { resource: 'agent', kind: 'paid', labelKey: 'agentLimitExceededPaid' },
  { resource: 'agent', kind: 'noCount', labelKey: 'agentLimitExceededNoCount' },
  { resource: 'agent', kind: 'noCountClosed', labelKey: 'agentLimitExceededNoCountClosed' },
];
/** the two titles (the `nav` namespace) */
const TITLES = [{ billingOpen: true, labelKey: 'orgLimitBannerTitle' }, { billingOpen: false, labelKey: 'orgLimitBannerTitleClosed' }] as const;

const keyOf = (resource: LimitResource, kind: Kind): string | null => CATALOG.find((r) => r.resource === resource && r.kind === kind)?.labelKey ?? null;
const line = (resource: LimitResource, kind: Kind, withLimit: boolean): LimitCopy['reason'] => {
  const key = keyOf(resource, kind);
  return key ? { ns: NS[resource], key, withLimit } : null;
};
const NS: Record<LimitResource, 'onboarding' | 'recruiter'> = { org: 'onboarding', project: 'onboarding', agent: 'recruiter' };
const titleOf = (billingOpen: boolean): LimitCopy['title'] => TITLES.find((t) => t.billingOpen === billingOpen)!.labelKey;

export function limitCopy({ resource, limit, free, billingOpen }: LimitCopyInput): LimitCopy {
  if (!billingOpen) {
    // closed: the free plan's fact only (a paid plan does not exist where billing is closed — no paid branch)
    const reason = limit === 0 ? line(resource, 'zeroClosed', false) : limit === null ? line(resource, 'noCountClosed', false) : line(resource, 'exceededClosed', true);
    return { title: titleOf(false), reason, link: false };
  }
  const title = titleOf(true);
  if (limit === 0 && free) return { title, reason: line(resource, 'zero', false), link: true };
  if (limit === null) return { title, reason: free ? line(resource, 'noCount', false) : null, link: true };
  if (!free && keyOf(resource, 'paid')) return { title, reason: line(resource, 'paid', true), link: true };
  return { title, reason: line(resource, 'exceeded', true), link: true };
}
