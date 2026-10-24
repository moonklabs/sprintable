'use client';

// story #4763 AC6 — the first screen of a person who has no account: one sentence on what this is and the way to the Mac app. It lives in this file, not in the login page, so the page
// itself keeps no branch for the Mac app's screens (story 4427, PO 09:58Z — pinned by a test that reads the page's source).
// The «받기» path exists only where the download does (`DESKTOP_DOWNLOAD_ENABLED` is read on the SERVER — not in the client bundle — so the server layout of /login hands the answer
// down through this context; with no provider, as in a test of the page alone or any other tree, the offer is off). It is drawn on a Mac only: the user agent is read after mount
// (no server/client mismatch) — a phone or another OS sees the login as before.
// The link is a plain sign-up: a new account has no organization, so the signed-in area sends it to the onboarding (a `next` to the download page would be dropped there), which stands behind the
// e-mail check, makes the organization and then opens on the app's download — that is why the hint says «메일 인증을 마치면», not «바로».
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
      <p className="break-keep text-sm text-foreground/90">{t('macAppPitch')}</p>
      <Link href="/register" className={`${buttonVariants({ variant: 'outline' })} w-full min-h-[44px]`}>
        {t('macAppGet')}
      </Link>
      <p className="break-keep text-xs text-muted-foreground">{t('macAppGetHint')}</p>
    </Card>
  );
}
