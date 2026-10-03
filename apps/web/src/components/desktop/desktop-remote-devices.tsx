'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { deviceDateOptions } from '@/lib/desktop-devices';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

/**
 * story #4533 AC3 (명세 모음 «B-1 ③ 웹 내 설정 · 원격 기기 — 목록과 [빼기]만») — my phones as pairs, one line per phone ↔ computer:
 * the phone's name · «짝: {computer}» · when paired · the confirmation number (the same six digits the phone app's «이 폰» shows) ·
 * [빼기] with an in-line confirmation. The web never pairs (the QR is the desktop app's) and never adds a phone.
 */
interface Pair { setup_id: string; device_name: string | null; paired_at: string }
interface Phone { id: string; label: string; confirm_number: string; last_used_at: string | null; pairs: Pair[] }

export function DesktopRemoteDevices() {
  const t = useTranslations('desktop.remoteDevices');
  const { orgId, orgMemberships } = useDashboardContext();
  const orgName = orgMemberships.find((o) => o.orgId === orgId)?.orgName ?? null;
  const [remoteControlOn, setRemoteControlOn] = useState<boolean | null>(null);
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null); // `${phone}:${setup}` being confirmed
  const [result, setResult] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/remote-devices');
      const body = res.ok ? ((await res.json()) as { devices?: Phone[] }) : null;
      setPhones(Array.isArray(body?.devices) ? body.devices : null);
    } catch {
      setPhones(null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { // «꺼져 있으면» line: the same read the «원격 제어» card makes
    if (!orgId) return;
    let off = false;
    void fetchWithAuth(`/api/organizations/${orgId}/remote-control`)
      .then(async (res) => (res.ok ? ((await res.json()) as { data?: { enabled: boolean } }).data?.enabled ?? null : null))
      .catch(() => null)
      .then((v) => { if (!off) setRemoteControlOn(v); });
    return () => { off = true; };
  }, [orgId]);

  const remove = useCallback(async (phone: Phone, pair: Pair) => {
    try {
      const res = await fetchWithAuth(`/api/remote-devices/${phone.id}/pairs/${pair.setup_id}`, { method: 'DELETE' });
      if (!res.ok) { setResult(t('removeFailed')); return; }
      const body = (await res.json()) as { removed?: boolean };
      // the name in the label place, no particle after it (Yuna 14:15Z ① — a phone's name is often Latin: «iPhone와» is wrong)
      setResult(body.removed ? t('removed', { phone: phone.label }) : t('alreadyRemoved', { phone: phone.label }));
      await load();
    } catch {
      setResult(t('removeFailed'));
    } finally {
      setAsking(null);
    }
  }, [load, t]);

  if (phones === null) return null; // not loaded · not an org person: the page goes on without it
  const rows = phones.flatMap((phone) => phone.pairs.map((pair) => ({ phone, pair })));

  return (
    <section className="break-keep flex flex-col gap-2" data-testid="desktop-remote-devices" aria-labelledby="desktop-remote-devices-title">
      <h2 id="desktop-remote-devices-title" className="text-base font-semibold">{t('title')}</h2>
      {remoteControlOn === false && orgName ? (
        <p className="text-xs text-muted-foreground">{t('orgOff', { org: orgName })}</p>
      ) : null}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map(({ phone, pair }) => {
            const key = `${phone.id}:${pair.setup_id}`;
            return (
              <li key={key} className="flex flex-col gap-1 px-4 py-3" data-testid="desktop-remote-device-row">
                <PairLine phone={phone} pair={pair} onRemove={() => { setResult(''); setAsking(key); }} disabled={asking !== null} />
                {asking === key ? (
                  <ConfirmRemove phone={phone} pair={pair} onConfirm={() => void remove(phone, pair)} onCancel={() => setAsking(null)} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground" role="status">{result}</p>
    </section>
  );
}

function PairLine({ phone, pair, onRemove, disabled }: { phone: Phone; pair: Pair; onRemove: () => void; disabled: boolean }) {
  const t = useTranslations('desktop.remoteDevices');
  const format = useFormatter();
  const tz = useViewerTimeZone() ?? 'UTC';
  const date = format.dateTime(new Date(pair.paired_at), { ...deviceDateOptions(pair.paired_at, new Date(), tz), timeZone: tz });
  const used = phone.last_used_at ? format.relativeTime(new Date(phone.last_used_at), new Date()) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm font-medium">{phone.label}</span>
      <span className="text-sm text-muted-foreground">{t('pairedWith', { device: pair.device_name ?? t('unknownDevice') })}</span>
      <span className="text-xs text-muted-foreground">{used ? t('pairedOnUsed', { date, used }) : t('pairedOn', { date })}</span>
      <span className="text-xs text-muted-foreground" title={t('confirmNumberHint')}>{t('confirmNumber', { number: phone.confirm_number })}</span>
      <Button size="sm" variant="outline" className="ml-auto" disabled={disabled} onClick={onRemove}>{t('remove')}</Button>
    </div>
  );
}

function ConfirmRemove({ phone, pair, onConfirm, onCancel }: { phone: Phone; pair: Pair; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('desktop.remoteDevices');
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []); // [취소] first, as the remote-control card's confirmation
  const text = t('confirmRemove', { phone: phone.label, device: pair.device_name ?? t('unknownDevice') });
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2" role="group" aria-label={text}>
      <p className="text-sm">{text}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={onConfirm}>{t('remove')}</Button>
        <Button size="sm" variant="outline" ref={cancelRef} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
