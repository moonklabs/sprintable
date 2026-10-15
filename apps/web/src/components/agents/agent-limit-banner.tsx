'use client';

import { useTranslations } from 'next-intl';
import { useFlatHref } from '@/hooks/use-flat-href';
import type { AgentLimit } from '@/lib/agent-limit';

/**
 * [SID:4680] (Yuna §N · PO 10-15 · walk 0-5): the recruiter's answer to the plan's agent limit (402 PLAN_LIMIT_EXCEEDED · resource=agent) — the family of the
 * project limit's banner (§K): title `nav.orgLimitBannerTitle`, one reason line, the way `nav.orgLimitUpgradeLink` → `/settings?tab=billing`. No «try again»
 * (it would not help) and no «how many now». The reason: free → `recruiter.agentLimitExceededError` with the server's limit · another tier →
 * `agentLimitExceededPaid` · no limit in the answer → the free «all made» line without a number (free) / no reason line at all (any other tier — no
 * word was given for it and no number is made up). What was typed and picked stays; this takes the place of the general failure line.
 */
export function AgentLimitBanner({ limit, free }: AgentLimit) {
  const t = useTranslations('nav');
  const tRecruiter = useTranslations('recruiter');
  const flatHref = useFlatHref();
  const reason = limit !== null
    ? tRecruiter(free ? 'agentLimitExceededError' : 'agentLimitExceededPaid', { limit })
    : free ? tRecruiter('agentLimitExceededNoCount') : null;
  return (
    <div data-testid="agent-limit-banner" role="alert" aria-live="assertive" aria-atomic="true" className="rounded-md border border-warning-border bg-warning-tint px-3 py-3 text-sm space-y-1">
      <p className="font-medium text-warning-strong break-keep">{t('orgLimitBannerTitle')}</p>
      {reason ? <p className="text-warning-strong break-keep">{reason}</p> : null}
      <a
        href={flatHref('/settings?tab=billing')}
        className="inline-block mt-1 text-xs font-medium text-warning-strong underline underline-offset-2 transition hover:opacity-80"
      >
        {t('orgLimitUpgradeLink')}
      </a>
    </div>
  );
}
