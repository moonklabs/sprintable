'use client';

// story #4763 AC6 — the first screen of a person who has no account: one sentence on what this is and the way to the Mac app. It lives in this file, not in the login page, so the page
// itself keeps no branch for the Mac app's screens (story 4427, PO 09:58Z — pinned by a test that reads the page's source).
// The «받기» path exists only where the download does (`DESKTOP_DOWNLOAD_ENABLED` is read on the SERVER — not in the client bundle — so the server layout of /login hands the answer
// down through this context; with no provider, as in a test of the page alone or any other tree, the offer is off). It is drawn on a Mac only: the user agent is read after mount
// (no server/client mismatch) — a phone or another OS sees the login as before.
// «받기» is the file itself, no sign-up in between (PO 10-26: the download card used to stand behind the account + the e-mail check — the «끊김» the comparison report named): a plain link to the
// public redirect /desktop/get/macos (a route, so a plain <a>: no client navigation, no prefetch). The sign-up then happens in the app — it opens the browser on its own — which is what the hint
// says; the web sign-up stays as the second link for a person who would rather start there (it reaches the same download after the e-mail check, on the onboarding).
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { notAMac } from '@/components/desktop/desktop-download-card';

const MacAppOfferContext = createContext(false);

export function MacAppOfferProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <MacAppOfferContext.Provider value={enabled}>{children}</MacAppOfferContext.Provider>;
}

const subscribeToNothing = () => () => {};

/** `suppressed`: the person came with an errand (an invite · a page to return to · an expired session) — the login comes first, nothing else is offered. */
export function MacAppOffer({ suppressed }: { suppressed: boolean }) {
  const t = useTranslations('login');
  const enabled = useContext(MacAppOfferContext);
  const { inPhoneApp } = usePhoneBridge();
  const onAMac = useSyncExternalStore(subscribeToNothing, () => !notAMac(navigator.userAgent, inPhoneApp), () => false);
  if (!enabled || suppressed || !onAMac) return null;
  return (
    <Card className="space-y-2 p-3 text-center" data-testid="login-mac-app-offer">
      <p className="break-keep text-sm text-foreground">{t('macAppPitch')}</p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a file download (a route handler that redirects to the file), not a page: <Link> would try a client navigation to it */}
      <a href="/desktop/get/macos" className={`${buttonVariants({ variant: 'outline' })} w-full min-h-[44px]`}>
        {t('macAppGet')}
      </a>
      <p className="break-keep text-xs text-muted-foreground">{t('macAppGetHint')}</p>
      <Link href="/register" className="inline-block min-h-[44px] break-keep px-2 text-xs text-muted-foreground underline underline-offset-2">
        {t('macAppWebSignup')}
      </Link>
    </Card>
  );
}
