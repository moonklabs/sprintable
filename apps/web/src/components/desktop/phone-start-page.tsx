'use client';

// story 4714 (AC3) — «○○ 맥에서 에이전트를 시작할까요?» at its own address: the phone app's start screen for a person who is paired with a computer and
// whose agents are not running. It was only inside the onboarding's first screen, which a person with an organization never sees. Same screen, same
// words, except the note above the way out (it says «you don't have to do this now», not the onboarding's «…reopen from Settings›download»); the way out is the
// onboarding's own button — [오늘로 가기] — so no launch traps anyone here.
import { markLeaving } from '@/lib/phone-start';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { PhoneFirstScreen } from '@/components/desktop/phone-first-screen';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { fetchWithAuth } from '@/lib/db/client';
import { existingOrgIdFromMe } from '@/app/onboarding/existing-org';
import { BRIDGE_WAIT_MS } from '@/components/desktop/phone-landing';

/** `homeHref`: where the way out goes — the onboarding's own landing address, resolved by the server from the nav flags (`resolveOnboardingLandingHref`, lib/onboarding-landing-href.ts); its words follow the same flag as the onboarding's own finish button */
export function PhoneStartPage({ chatsHref, homeHref, todayV3Enabled, macDownloadEnabled }: { chatsHref: string; homeHref: string; todayV3Enabled: boolean; macDownloadEnabled: boolean }) {
  const to = useTranslations('onboarding');
  const tp = useTranslations('onboarding.phone');
  const { inPhoneApp } = usePhoneBridge();
  const [orgId, setOrgId] = useState<string | null>(null);
  // the organization's id is only for «turn remote control on» (the screen's first branch) — read here, as the onboarding does
  useEffect(() => {
    let alive = true;
    void fetchWithAuth('/api/auth/me').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((json) => { if (alive) setOrgId(existingOrgIdFromMe(json)); });
    return () => { alive = false; };
  }, []);
  // this screen is the phone app's: anywhere else (a browser that opened the address) it goes home after the claim had its moment
  useEffect(() => {
    if (inPhoneApp) return;
    const timer = setTimeout(() => window.location.replace(homeHref), BRIDGE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [inPhoneApp, homeHref]);
  if (!inPhoneApp) return <div className="min-h-screen bg-background" aria-busy="true" data-testid="phone-start-wait" />;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-4" data-testid="phone-start-page">
        <PhoneFirstScreen orgId={orgId} chatsHref={chatsHref} macDownloadEnabled={macDownloadEnabled} />
        <p className="break-keep border-t border-border pt-4 text-xs text-muted-foreground" data-testid="phone-start-later">
          {tp('laterNote')}{' '}
          <Button variant="link" size="sm" className="h-auto px-0 py-0 text-xs" onClick={() => { if (markLeaving()) window.location.assign(homeHref); /* a second tap is not a second navigation */ }} data-testid="phone-start-finish">
            {todayV3Enabled ? to('desktopFinishToToday') : to('dashboardCta')}
          </Button>
        </p>
      </div>
    </div>
  );
}
