'use client';

// story #4763 AC5 — /desktop opens with «앱 열기» on a Mac: a person who comes from a mailed link or a bookmark very often HAS the app, and a page that only offers [다운로드] sends them
// to download what they already have. A browser cannot tell whether an app is installed, so the card does not claim it: «앱 열기» first (the app's own scheme — dev or prod — the same
// link the onboarding's first screen uses), and one line under it for the person with no app: the download is just below. Not a Mac (a phone · another OS · the phone app's shell):
// nothing is drawn — the download card there already says «Mac에서 열어 주세요».
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { appSetupLink } from '@/lib/auth/native-return-app';
import { notAMac } from '@/components/desktop/desktop-download-card';

export function DesktopOpenAppCard() {
  const t = useTranslations('desktop');
  const { inPhoneApp } = usePhoneBridge();
  const elsewhere = typeof navigator === 'undefined' || notAMac(navigator.userAgent, inPhoneApp);
  if (elsewhere) return null;
  return (
    <Card className="space-y-2 p-4" data-testid="desktop-open-app-card">
      <p className="text-sm font-medium text-foreground">{t('openAppTitle')}</p>
      <Button asChild size="sm" data-testid="desktop-open-app-button">
        <a href={appSetupLink(null)}>{t('openAppCta')}</a>
      </Button>
      <p className="break-keep text-xs text-muted-foreground" data-testid="desktop-open-app-note">{t('openAppNoAppNote')}</p>
    </Card>
  );
}
