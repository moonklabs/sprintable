'use client';
// story 4654 (Yuna 4654-phone-app-cta-design §1 · §3): the onboarding desktop step puts the phone app's links (PhoneAppGet) under the
// download card; on a device that is not a Mac the aux line «맥 앱은 맥에서 받아 주세요» goes with them.
// [SID:4671] (UX-1 · U3): a Mac draws the card too — the QR is for the phone's camera, so the person at the Mac is exactly who needs
// it (before, the card was hidden on a Mac and the phone app was first heard of in the pairing window's title). On a Mac the aux line
// is replaced by «scan it with your phone». Nothing to get (no store open · no opt-in page · phoneAppLinks = []) → nothing drawn.
import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET, phoneAppLinks } from '@/lib/phone-app-store';
import { notAMac } from '@/components/desktop/desktop-download-card';
import { PhoneAppGet } from '@/components/desktop/phone-pairing';

const noSubscribe = () => () => undefined;


export function PhoneAppCard({ elsewhere: forced }: { elsewhere?: boolean }) {
  const t = useTranslations('phonePairing');
  // read as a snapshot, not set in an effect (no cascading render): null on the server and before the first read
  const { inPhoneApp } = usePhoneBridge();
  const detected = useSyncExternalStore(noSubscribe, () => notAMac(navigator.userAgent, inPhoneApp), () => null);
  const elsewhere = forced ?? detected;
  if (phoneAppLinks(PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET).length === 0) return null;
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="phone-app-card">
      {/* a Mac → how the QR is used, under the body (Yuna §D); not a Mac → where the Mac app is, at the bottom; unknown (server · before the read) → neither */}
      <PhoneAppGet body={t('needPhoneAppBody')} scanHint={elsewhere === false} />
      {elsewhere === true ? <p className="text-xs text-muted-foreground" data-testid="phone-app-mac-aux">{t('macAppAux')}</p> : null}
    </Card>
  );
}
