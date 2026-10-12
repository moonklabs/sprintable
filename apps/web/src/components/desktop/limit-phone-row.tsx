'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatViewerRelativeTime } from '@/lib/storage/format';

/** story #4624 — one phone of the person's account on the limit screen (its pairs are the computers it is paired to now). */
export interface LimitPhone { id: string; label: string; last_used_at: string | null; pairs?: { device_name: string | null }[] }

/**
 * One phone row on the limit screen: its name, when it was last used (or «아직 안 씀»), [이 폰 빼기], and the one confirm.
 * Kept in its own file so the phone-pairing screen never draws the removal copy next to its own pairing words.
 */
export function LimitPhoneRow({ phone, asking, onAsk, onConfirm, onCancel }: {
  phone: LimitPhone;
  asking: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const tr = useTranslations('desktop.remoteDevices');
  const locale = useLocale();
  // the viewer's own zone: a last use past a week is a date there (never UTC, never blank)
  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const t = useTranslations('phonePairing');
  const pairs = phone.pairs?.length ?? 0;
  return (
    <li className="flex flex-col gap-1" data-testid="pairing-limit-phone">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{phone.label}</span>
        {asking ? null : <Button variant="outline" size="sm" onClick={onAsk}>{tr('removePhone')}</Button>}
      </div>
      <span className="text-xs text-muted-foreground">{phone.last_used_at ? tr('lastUsed', { used: formatViewerRelativeTime(phone.last_used_at, locale, viewerTz) }) : t('limit.neverUsed')}</span>
      {asking ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{pairs > 0 ? tr('confirmRemovePhone', { phone: phone.label, n: pairs }) : tr('confirmRemovePhoneUnpaired', { phone: phone.label })}</p>
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" onClick={onConfirm}>{tr('removePhone')}</Button>
            <Button variant="outline" size="sm" onClick={onCancel}>{tr('cancel')}</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
