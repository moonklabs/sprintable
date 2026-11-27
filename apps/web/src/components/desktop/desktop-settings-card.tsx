'use client';

// story 5038 (C8 · B 설정 칸 · web side): inside the desktop app, `/desktop` also holds the app's OWN settings — the three notices outside the window, «this computer only», the Dock badge, the menu-bar icon and
// «keep the app when the window closes». They live in the app (its settings file), not on our server: this card reads them and writes them through the app's bridge (`desktopSettings` · `writeDesktopSettings`).
// It is drawn ONLY when the app gives the settings and both hands (an older app has none → nothing here; a browser has no bridge → nothing here). The rule of the app's own menu switches holds: a switch shows the value the app KEPT,
// a press writes it, and a write that fails leaves the switch as it was and says so — the page never shows what it merely asked for.
import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { Toggle } from '@/components/ds/toggle';
import { DESKTOP_NOTICE_KINDS, desktopApp, desktopSettings, subscribeDesktopApp, subscribeDesktopSettings, writeDesktopSettings, type DesktopSettingsPatch, type SprintableDesktop } from '@/lib/desktop-app';

export function DesktopSettingsCard() {
  const bridge = useSyncExternalStore<SprintableDesktop | undefined>(subscribeDesktopApp, desktopApp, () => undefined);
  const settings = useSyncExternalStore(subscribeDesktopSettings, desktopSettings, () => null);
  const t = useTranslations('desktop.appSettings');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // the three words are read by their whole key, each written out (the dead-key scan of messages reads literal t('…') calls — a `kind.${kind}` would hide them from it)
  const kindLabel: Record<(typeof DESKTOP_NOTICE_KINDS)[number], string> = { needs_hand: t('kind.needs_hand'), finished: t('kind.finished'), failed: t('kind.failed') };
  if (!bridge || !settings) return null; // a browser · an older app · settings not in the app's closed shape: no cell

  const write = async (patch: DesktopSettingsPatch) => {
    setBusy(true); setFailed(false);
    try { if ((await writeDesktopSettings(patch, bridge)) !== 'ok') setFailed(true); } finally { setBusy(false); }
  };
  const sw = (id: string, label: string, checked: boolean, patch: (on: boolean) => DesktopSettingsPatch, note?: string) => (
    <li key={id} className="space-y-1" data-testid={`desktop-setting-${id}`}>
      <Toggle label={label} onText={t('stateOn')} offText={t('stateOff')} checked={checked} disabled={busy} onCheckedChange={(on) => { void write(patch(on)); }} />
      {note ? <p className="pl-1 text-ds-small text-ds-ink-3" data-testid={`desktop-setting-${id}-note`}>{note}</p> : null}
    </li>
  );

  return (
    <Card className="break-keep space-y-3 p-4" data-testid="desktop-settings-card">
      <h2 className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</h2>
      <p className="text-ds-small text-ds-ink-3">{t('scope')}</p>
      <div className="space-y-2">
        <h3 className="text-ds-body font-semibold text-ds-ink-2">{t('noticesTitle')}</h3>
        <ul className="space-y-2">
          {DESKTOP_NOTICE_KINDS.map((kind) => sw(`kind-${kind}`, kindLabel[kind], settings.kinds[kind], (on) => ({ kinds: { [kind]: on } })))}
          {sw('thisComputerOff', t('thisComputerOff'), settings.thisComputerOff, (on) => ({ thisComputerOff: on }), t('thisComputerOffNote'))}
        </ul>
      </div>
      <ul className="space-y-2">
        {sw('dockBadge', t('dockBadge'), settings.dockBadge, (on) => ({ dockBadge: on }))}
        {sw('trayIcon', t('trayIcon'), settings.trayIcon, (on) => ({ trayIcon: on }))}
        {sw('keepRunning', t('keepRunning'), settings.keepRunning, (on) => ({ keepRunning: on }), t('keepRunningNote'))}
      </ul>
      <p className="text-ds-small text-ds-failed" role="status" data-testid="desktop-settings-failed">{failed ? t('failed') : ''}</p>
    </Card>
  );
}
