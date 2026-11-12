'use client';
// story 4654 (Yuna 4654-phone-app-cta-design §1 · §3): the onboarding desktop step puts the phone app's links (PhoneAppGet) under the
// download card; on a device that is not a Mac the aux line «맥 앱은 맥에서 받아 주세요» goes with them.
// [SID:4671] (UX-1 · U3): a Mac draws the card too — the QR is for the phone's camera, so the person at the Mac is exactly who needs
// it (before, the card was hidden on a Mac and the phone app was first heard of in the pairing window's title). On a Mac the aux line
// is replaced by «scan it with your phone». Nothing to get (no store open · no opt-in page · phoneAppLinks = []) → nothing drawn.
import { useEmbeddedServer } from '@/components/embedded-server-context';
import { useId, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { Button } from '@/components/ds/button';
import { ListRow } from '@/components/ds/list-row';
import { Icon } from '@/components/ds/icon';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET, phoneAppLinks } from '@/lib/phone-app-store';
import { notAMac } from '@/components/desktop/desktop-download-card';
import { PhoneAppGet } from '@/components/desktop/phone-pairing';

const noSubscribe = () => () => undefined;


/** whether there is a phone app to get at all: not inside the app's own server (story 4832), and at least one store / opt-in link */
function usePhoneAppAvailable(): boolean {
  const embedded = useEmbeddedServer(); // story 4832: the app's own server has no phone relay — the phone app's QR could not reach a loopback server
  return !embedded && phoneAppLinks(PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET).length > 0;
}

/**
 * story 4891 (first screen · PO 11-10): on the Mac first screen the phone app is ONE row — «폰에서도 쓰기 ›» — and the card (QR + store links) opens in place
 * on a press. The phone pairing stays a customer path (not removed), one press behind. Nothing to get → no row.
 */
export function PhoneAppRow() {
  const t = useTranslations('phonePairing');
  const available = usePhoneAppAvailable();
  const [open, setOpen] = useState(false);
  const regionId = useId(); // one id per row (two rows on a page must not share a region)
  if (!available) return null;
  return (
    <div data-testid="phone-app-row">
      <ListRow asChild className="rounded-ds-control">
        <Button type="button" variant="quiet" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)} data-testid="phone-app-row-toggle" className="h-auto w-full justify-start">
          <span className="min-w-0 flex-1 truncate text-left text-ds-body font-semibold text-ds-ink">{t('useOnPhone')}</span>
          <Icon name={open ? 'expand_less' : 'chevron_right'} size={18} className="text-ds-ink-3" />
        </Button>
      </ListRow>
      <div id={regionId} hidden={!open} className="pt-2">{open ? <PhoneAppCard /> : null}</div>
    </div>
  );
}

export function PhoneAppCard({ elsewhere: forced }: { elsewhere?: boolean }) {
  const t = useTranslations('phonePairing');
  const available = usePhoneAppAvailable();
  // read as a snapshot, not set in an effect (no cascading render): null on the server and before the first read
  const { inPhoneApp } = usePhoneBridge();
  const detected = useSyncExternalStore(noSubscribe, () => notAMac(navigator.userAgent, inPhoneApp), () => null);
  const elsewhere = forced ?? detected;
  if (!available) return null;
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="phone-app-card">
      {/* a Mac → how the QR is used, under the body (Yuna §D); not a Mac → where the Mac app is, at the bottom; unknown (server · before the read) → neither */}
      <PhoneAppGet body={t('needPhoneAppBody')} scanHint={elsewhere === false} />
      {elsewhere === true ? <p className="text-ds-small text-ds-ink-3" data-testid="phone-app-mac-aux">{t('macAppAux')}</p> : null}
    </Card>
  );
}
