'use client';

// story 4970 — inside the desktop app the «데스크톱 앱» slot says which computer this is and which build runs, instead of offering the download (선생님 11-16).
// Nothing new is written: the title and the two lines are the card's own words (`title` · `deviceChipAria` · `versionLabel`); the values are the ones the app already gives the page
// (`device.name` — the app's own panel — and `appVersion`, 4970's one added value). An older app gives no version: that line is simply not drawn.
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { appVersionOf, type SprintableDesktop } from '@/lib/desktop-app';

export function DesktopThisComputerCard({ bridge, hideTitle = false }: { bridge: SprintableDesktop; hideTitle?: boolean }) {
  const t = useTranslations('desktop');
  const version = appVersionOf(bridge);
  const name = bridge.device.name.trim();
  return (
    <Card className="space-y-2 p-4" data-testid="desktop-this-computer-card">
      {hideTitle ? null : <p className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</p>}
      {name ? <p className="text-ds-small text-ds-ink-3" data-testid="desktop-this-computer-name">{t('deviceChipAria', { name })}</p> : null}
      {version ? <p className="text-ds-small text-ds-ink-3" data-testid="desktop-this-computer-version">{t('versionLabel', { version })}</p> : null}
    </Card>
  );
}
