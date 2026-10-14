'use client';

import { useTranslations } from 'next-intl';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * [SID:4681] (Yuna §K · PO 10-14 · walk 7): the «새 프로젝트» dialog's answer to the plan's project limit (402 PLAN_LIMIT_EXCEEDED). The same
 * three texts the organization dialog, the onboarding and the settings already say for the same event — title `nav.orgLimitBannerTitle`,
 * reason `onboarding.projectLimitExceededError` (free) / `projectLimitExceededPaid` (any other tier), the way `nav.orgLimitUpgradeLink` →
 * `/settings?tab=billing`. No count of «how many now» (the 402 does not carry `current`). Drawn at the form's top, in place of the general
 * failure line; what was typed and picked stays, [취소] leaves.
 */
export function ProjectLimitBanner({ limit, free }: { limit: number; free: boolean }) {
  const t = useTranslations('nav');
  const tOnboarding = useTranslations('onboarding');
  const flatHref = useFlatHref();
  return (
    <div data-testid="project-limit-banner" role="alert" aria-live="assertive" aria-atomic="true" className="rounded-md border border-warning-border bg-warning-tint px-3 py-3 text-sm space-y-1">
      <p className="font-medium text-warning-strong">{t('orgLimitBannerTitle')}</p>
      <p className="text-warning-strong">{tOnboarding(free ? 'projectLimitExceededError' : 'projectLimitExceededPaid', { limit })}</p>
      <a
        href={flatHref('/settings?tab=billing')}
        className="inline-block mt-1 text-xs font-medium text-warning-strong underline underline-offset-2 transition hover:opacity-80"
      >
        {t('orgLimitUpgradeLink')}
      </a>
    </div>
  );
}
