'use client';
// story 4654 (Yuna 4654-phone-app-cta-design §1 · §3): on a device that is not a Mac, the onboarding desktop step puts the phone app's
// store links (PhoneAppGet — only the published stores) under the download card, with the aux line «맥 앱은 맥에서 받아 주세요».
// On a Mac nothing is drawn (the Mac app card stays alone). Nothing published → nothing drawn (no dead link).
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { isPhoneApp } from '@/lib/phone-bridge';
import { PHONE_APP_PUBLISHED, phoneAppStoreLinks } from '@/lib/phone-app-store';
import { notAMac } from '@/components/desktop/desktop-download-card';
import { PhoneAppGet } from '@/components/desktop/phone-pairing';

export function PhoneAppCard({ elsewhere: forced }: { elsewhere?: boolean }) {
  const t = useTranslations('phonePairing');
  const [detected, setDetected] = useState<boolean | null>(null);
  useEffect(() => {
    if (forced === undefined) setDetected(notAMac(navigator.userAgent, isPhoneApp()));
  }, [forced]);
  const elsewhere = forced ?? detected;
  if (elsewhere !== true || phoneAppStoreLinks(PHONE_APP_PUBLISHED).length === 0) return null;
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="phone-app-card">
      <p className="text-xs text-muted-foreground">{t('macAppAux')}</p>
      <PhoneAppGet />
    </Card>
  );
}
