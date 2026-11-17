'use client';

// story 4970 — inside the desktop app the «데스크톱 앱» slot says which computer this is and which build runs, instead of offering the download (선생님 11-16).
// Nothing new is written: the title and the two lines are the card's own words (`title` · `deviceChipAria` · `versionLabel`); the values are the ones the app already gives the page
// (`device.name` — the app's own panel — and `appVersion`, 4970's one added value). An older app gives no version: that line is simply not drawn.
import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { appUpdate, appVersionOf, pressAppUpdate, subscribeAppUpdate, type SprintableDesktop } from '@/lib/desktop-app';

export function DesktopThisComputerCard({ bridge, hideTitle = false }: { bridge: SprintableDesktop; hideTitle?: boolean }) {
  const t = useTranslations('desktop');
  const version = appVersionOf(bridge);
  const name = bridge.device.name.trim();
  // story 4971 ③: a newer build the app found — a notice and ONE press (the app downloads it, checks it and restarts into it; nothing happens unasked)
  const offer = useSyncExternalStore(subscribeAppUpdate, appUpdate, () => null);
  const [pressing, setPressing] = useState(false);
  const canPress = !!offer && (offer.phase === 'available' || offer.phase === 'failed') && typeof bridge.startUpdate === 'function' && !pressing;
  const press = async () => { setPressing(true); try { await pressAppUpdate(); } finally { setPressing(false); } };
  return (
    <Card className="space-y-2 p-4" data-testid="desktop-this-computer-card">
      {hideTitle ? null : <p className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</p>}
      {name ? <p className="text-ds-small text-ds-ink-3" data-testid="desktop-this-computer-name">{t('deviceChipAria', { name })}</p> : null}
      {version ? <p className="text-ds-small text-ds-ink-3" data-testid="desktop-this-computer-version">{t('versionLabel', { version })}</p> : null}
      {offer ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="desktop-update-line" data-phase={offer.phase}>
          <p className="text-ds-small text-ds-ink" data-testid="desktop-update-text" role="status">
            {offer.phase === 'available' ? t('updateAvailable', { version: offer.version })
              : offer.phase === 'downloading' ? t('updateDownloading', { version: offer.version })
              : offer.phase === 'installing' ? t('updateInstalling', { version: offer.version })
              : t('updateFailed', { version: offer.version })}
          </p>
          {offer.phase === 'available' || offer.phase === 'failed' ? (
            <Button type="button" size="md" variant="primary" disabled={!canPress} onClick={() => { void press(); }} data-testid="desktop-update-button">
              {offer.phase === 'failed' ? t('updateRetry') : t('updateNow')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
