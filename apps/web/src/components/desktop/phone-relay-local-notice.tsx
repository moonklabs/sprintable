'use client';

// story 4829 (공개 2-⑥ (나)) — the phone relay needs a middle server that the app's own (local-mode) server does not have, so in local mode the phone-pairing and
// phone-control screens say so instead of drawing a pairing that cannot work. Draws nothing it has to fetch: no read, no request, so nothing can fail on this screen.
// Hosted mode never draws it (the pages decide with `isEmbeddedServer()` on the server).
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';

export function PhoneRelayLocalNotice() {
  const t = useTranslations('desktop.phoneRelayLocal');
  return (
    <Card className="break-keep flex flex-col gap-1 p-4" data-testid="phone-relay-local-notice">
      <p className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</p>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
    </Card>
  );
}
