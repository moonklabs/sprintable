'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { subscribeSessionExpired } from '@/lib/auth/session-expired-signal';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';

/**
 * story 4766 (AC5): the session ended while a person was on the onboarding. `fetchWithAuth` tells the whole page (session-expired-signal) and
 * from then on answers 401 without asking the network — but the session-expired dialog is mounted only in the dashboard shell
 * (dashboard-shell.tsx), so here nothing was said: the connection panel stood on «대기» with no way out but a reload nobody was told to make.
 * One line and one button, drawn only when the signal comes: [다시 로그인] goes to the sign-in with this very address as `next`, so the person
 * lands on the same onboarding page (the arrival finds their organization and opens the same screen — nothing is made twice).
 * It does not take the page away (no modal): what the person was reading stays under it.
 */
export function OnboardingSessionExpiredNotice() {
  const t = useTranslations('onboarding');
  const [expired, setExpired] = useState(false);

  useEffect(() => subscribeSessionExpired(() => setExpired(true)), []);

  if (!expired) return null;
  const relogin = () => {
    window.location.href = buildLoginRedirect(`${window.location.pathname}${window.location.search}`);
  };
  return (
    <div
      role="alert"
      data-testid="onboarding-session-expired"
      className="mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-tint px-3 py-2.5 text-sm text-foreground"
    >
      <span className="min-w-0 break-keep">{t('sessionExpired')}</span>
      <Button size="sm" onClick={relogin} data-testid="onboarding-session-expired-relogin" className="shrink-0 whitespace-nowrap">
        {t('sessionExpiredCta')}
      </Button>
    </div>
  );
}
