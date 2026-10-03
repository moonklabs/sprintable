'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { deviceDateOptions } from '@/lib/desktop-devices';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useOrgRemoteControl } from '@/lib/org-remote-control';
import { useFlatHref } from '@/hooks/use-flat-href';
import { isPhoneApp } from '@/lib/phone-bridge';

/**
 * story #4533 AC3 (명세 모음 «B-1 ③ 웹 내 설정 · 원격 기기 — 목록과 [빼기]만») — my phones as pairs, one line per phone ↔ computer:
 * the phone's name · «짝: {computer}» · when paired · the confirmation number (the same six digits the phone app's «이 폰» shows) ·
 * [빼기] with an in-line confirmation. The web never pairs (the QR is the desktop app's) and never adds a phone.
 * story #4532 — inside the phone app (its bridge claimed) one more button: [컴퓨터와 짝짓기] → the phone's pairing screen.
 */
interface Pair { setup_id: string; device_name: string | null; paired_at: string }
interface Phone { id: string; label: string; confirm_number: string; last_used_at: string | null; pairs: Pair[] }

export function DesktopRemoteDevices() {
  const t = useTranslations('desktop.remoteDevices');
  const { orgId, orgMemberships } = useDashboardContext();
  const orgName = orgMemberships.find((o) => o.orgId === orgId)?.orgName ?? null;
  // the switch card's own value (story #4535 · PO 18:58Z): turned on or off there, the «꺼져 있어요» line follows at once
  const [remoteControl] = useOrgRemoteControl(orgId);
  const remoteControlOn = remoteControl ? remoteControl.enabled : null;
  const inPhoneApp = useSyncExternalStore(noSubscribe, isPhoneApp, notOnServer);
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null); // `${phone}:${setup}` being confirmed
  const [result, setResult] = useState('');
  // where the focus goes when the in-line confirmation closes (Yuna 15:38Z · as 4935's web confirmation): [취소] → that row's
  // [빼기] · after asking the server → the result line (the row may be gone). Applied once the buttons are enabled again.
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<{ row: string } | 'status' | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    if (asking !== null || next === null) return;
    focusNext.current = null;
    if (next === 'status') statusRef.current?.focus();
    else removeButtons.current.get(next.row)?.focus();
  }, [asking, result, phones]);

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
      focusNext.current = 'status';
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
        <Card className="p-0">
        <ul className="flex flex-col divide-y divide-border">
          {rows.map(({ phone, pair }) => {
            const key = `${phone.id}:${pair.setup_id}`;
            return (
              <li key={key} className="flex flex-col gap-1 px-4 py-3" data-testid="desktop-remote-device-row">
                <PairLine
                  phone={phone} pair={pair} onRemove={() => { setResult(''); setAsking(key); }} disabled={asking !== null}
                  buttonRef={(el) => { if (el) removeButtons.current.set(key, el); else removeButtons.current.delete(key); }}
                />
                {asking === key ? (
                  <ConfirmRemove
                    phone={phone} pair={pair} onConfirm={() => void remove(phone, pair)}
                    onCancel={() => { focusNext.current = { row: key }; setAsking(null); }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        </Card>
      )}
      {inPhoneApp ? <PairEntry /> : null}
      <p ref={statusRef} tabIndex={-1} className="text-xs text-muted-foreground outline-none" role="status">{result}</p>
    </section>
  );
}

const noSubscribe = () => () => {};
const notOnServer = () => false;

/** story #4532 — only inside the phone app: this phone pairs from here (the shell has the camera and the key). */
function PairEntry() {
  const t = useTranslations('phonePairing');
  const flat = useFlatHref();
  return <div><Button size="sm" variant="outline" asChild><a href={flat('/desktop/pair')}>{t('entry')}</a></Button></div>;
}

function PairLine({ phone, pair, onRemove, disabled, buttonRef }: {
  phone: Phone; pair: Pair; onRemove: () => void; disabled: boolean; buttonRef: (el: HTMLButtonElement | null) => void;
}) {
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
      <Button ref={buttonRef} size="sm" variant="outline" className="ml-auto" disabled={disabled} onClick={onRemove}>{t('remove')}</Button>
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
