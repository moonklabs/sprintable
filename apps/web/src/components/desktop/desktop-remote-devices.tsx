'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { deviceDateOptions } from '@/lib/desktop-devices';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useOrgRemoteControl } from '@/lib/org-remote-control';
import { isPhoneApp } from '@/lib/phone-bridge';
import { PhonePairEntry } from './phone-pairing';

/**
 * story #4533 AC3 (명세 모음 «B-1 ③ 웹 내 설정 · 원격 기기 — 목록과 [빼기]만») — my phones and their pairs: the phone's name · its
 * confirmation number (the same six digits the phone app's «이 폰» shows) · when last used · «짝: {computer}» per pair with [빼기]
 * (that pair only). The web never pairs (the QR is the desktop app's) and never adds a phone.
 * story #4624 (1선 · Yuna «미르코 범위»): grouped by phone — each phone's head line has [이 폰 빼기] (the key itself: every pair goes
 * and its place under the three-phone limit is free again). A phone with no pair left is listed too («짝 없음»): before, the list
 * was one line per pair, so a key holding a place with no pair was invisible and could never be removed. The longest unused first.
 * story #4532 — inside the phone app (its bridge claimed) one more button: [컴퓨터와 짝짓기] → the phone's pairing screen.
 */
interface Pair { setup_id: string; device_name: string | null; paired_at: string }
interface Phone { id: string; label: string; confirm_number: string; last_used_at: string | null; created_at?: string | null; pairs: Pair[] }

/** what is being confirmed: one pair (`${phone}:${setup}`) or a whole phone (`phone:${id}`) */
type Asking = string | null;
/** a DELETE's answer — story #4629: removing a phone also says whether its login was ended (`session`; absent from an older server) */
interface RemoveAnswer { removed: boolean; session: 'ended' | 'not_found' | null }

/** Yuna §③: the phone not used the longest first (never used = oldest) — the one to remove is seen first */
function byLeastRecentlyUsed(a: Phone, b: Phone): number {
  const at = (p: Phone) => (p.last_used_at ? Date.parse(p.last_used_at) : -Infinity);
  return at(a) - at(b) || (a.created_at ?? '').localeCompare(b.created_at ?? '');
}

export function DesktopRemoteDevices() {
  const t = useTranslations('desktop.remoteDevices');
  const { orgId, orgMemberships } = useDashboardContext();
  const orgName = orgMemberships.find((o) => o.orgId === orgId)?.orgName ?? null;
  // the switch card's own value (story #4535 · PO 18:58Z): turned on or off there, the «꺼져 있어요» line follows at once
  const [remoteControl] = useOrgRemoteControl(orgId);
  const remoteControlOn = remoteControl ? remoteControl.enabled : null;
  const inPhoneApp = useSyncExternalStore(noSubscribe, isPhoneApp, notOnServer);
  const flatHref = useFlatHref(); // story #4630 AC3 — the settings link carries this project (`?p=` · #4231)
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [result, setResult] = useState<ReactNode>('');
  // story #4629 (Yuna «4629»): a removal whose phone login could not be ended reads in the text colour (not a warning — nothing to do next)
  const [resultStrong, setResultStrong] = useState(false);
  // where the focus goes when the in-line confirmation closes (Yuna 15:38Z · as 4935's web confirmation): [취소] → that row's
  // button · after asking the server → the result line (the row may be gone). Applied once the buttons are enabled again.
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

  /** one DELETE, then the result line and the list read again */
  const ask = useCallback(async (url: string, said: (answer: RemoveAnswer) => ReactNode) => {
    setResultStrong(false);
    try {
      const res = await fetchWithAuth(url, { method: 'DELETE' });
      if (!res.ok) { setResult(t('removeFailed')); return; }
      const body = (await res.json()) as { removed?: boolean; session?: unknown };
      const answer: RemoveAnswer = { removed: body.removed === true, session: body.session === 'ended' || body.session === 'not_found' ? body.session : null };
      setResult(said(answer));
      setResultStrong(answer.removed && answer.session === 'not_found');
      await load();
    } catch {
      setResult(t('removeFailed'));
    } finally {
      focusNext.current = 'status';
      setAsking(null);
    }
  }, [load, t]);
  // the name in the label place, no particle after it (Yuna 14:15Z ① — a phone's name is often Latin: «iPhone와» is wrong)
  const removePair = (phone: Phone, pair: Pair) => ask(`/api/remote-devices/${phone.id}/pairs/${pair.setup_id}`,
    ({ removed }) => (removed ? t('removed', { phone: phone.label }) : t('alreadyRemoved', { phone: phone.label })));
  // story #4629: whether that phone's login was ended too · a server that does not say (older) → the line as before, no claim either way
  const removePhone = (phone: Phone) => ask(`/api/remote-devices/${phone.id}`, ({ removed, session }) => {
    if (!removed) return t('alreadyRemoved', { phone: phone.label });
    if (session === 'ended') return t('phoneRemovedSignedOut', { phone: phone.label });
    // story #4630 AC3 (Yuna «4630» ③): the next hand when its login was not found — a link to «로그인한 다른 기기» (settings ›
    // account), never run from here: that card's own confirmation goes first
    if (session === 'not_found') {
      return t.rich('phoneRemovedSessionNotFound', {
        phone: phone.label,
        lk: (chunks) => <Link href={flatHref('/settings?tab=profile')} className="underline underline-offset-2" data-testid="desktop-remote-devices-sign-out-elsewhere">{chunks}</Link>,
      });
    }
    return t('phoneRemoved', { phone: phone.label });
  });

  if (phones === null) return null; // not loaded · not an org person: the page goes on without it
  const keep = (key: string) => (el: HTMLButtonElement | null) => { if (el) removeButtons.current.set(key, el); else removeButtons.current.delete(key); };
  const open = (key: string) => () => { setResult(''); setAsking(key); };
  const close = (key: string) => () => { focusNext.current = { row: key }; setAsking(null); };

  return (
    <section className="break-keep flex flex-col gap-2" data-testid="desktop-remote-devices" aria-labelledby="desktop-remote-devices-title">
      <h2 id="desktop-remote-devices-title" className="text-base font-semibold">{t('title')}</h2>
      {remoteControlOn === false && orgName ? (
        <p className="text-xs text-muted-foreground">{t('orgOff', { org: orgName })}</p>
      ) : null}
      {phones.length === 0 ? (
        <>
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
          {/* story 4645 AC7: the web cannot open the app's pairing window — say where it is. Only when the org's remote control is known on: off or not yet
              known, the tail names no pairing (PO · Yuna 19:00Z · design CHANGES) */}
          {remoteControlOn === true ? <p className="text-xs text-muted-foreground">{t('pairHint')}</p> : null}
        </>
      ) : (
        <Card className="p-0">
        <ul className="flex flex-col divide-y divide-border">
          {[...phones].sort(byLeastRecentlyUsed).map((phone) => {
            const phoneKey = `phone:${phone.id}`;
            return (
              <li key={phone.id} className="flex flex-col gap-2 px-4 py-3" data-testid="desktop-remote-phone">
                <PhoneHead phone={phone} onRemove={open(phoneKey)} disabled={asking !== null} buttonRef={keep(phoneKey)} />
                {asking === phoneKey ? (
                  <Confirm text={phone.pairs.length === 0
                    // Yuna 08:14Z: no pair → no «승인 · 멈춤 · 지시를 할 수 없고» (a cost it does not have) — its own line
                    ? t('confirmRemovePhoneUnpaired', { phone: phone.label })
                    : t('confirmRemovePhone', { phone: phone.label, n: phone.pairs.length })}
                    onConfirm={() => void removePhone(phone)} onCancel={close(phoneKey)} />
                ) : null}
                {phone.pairs.length === 0 ? <p className="pl-4 text-xs text-muted-foreground">{t('noPairs')}</p> : (
                  <ul className="flex flex-col gap-1 pl-4">
                    {phone.pairs.map((pair) => {
                      const key = `${phone.id}:${pair.setup_id}`;
                      return (
                        <li key={key} className="flex flex-col gap-1" data-testid="desktop-remote-device-row">
                          <PairLine pair={pair} onRemove={open(key)} disabled={asking !== null} buttonRef={keep(key)} />
                          {asking === key ? (
                            <Confirm text={t('confirmRemove', { phone: phone.label, device: pair.device_name ?? t('unknownDevice') })} confirmLabel={t('unpair')}
                              onConfirm={() => void removePair(phone, pair)} onCancel={close(key)} />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        </Card>
      )}
      {inPhoneApp ? <PhonePairEntry /> : null}
      <p ref={statusRef} tabIndex={-1} className={`text-xs outline-none ${resultStrong ? 'text-foreground' : 'text-muted-foreground'}`} role="status"
        data-testid="desktop-remote-devices-result">{result}</p>
    </section>
  );
}

const noSubscribe = () => () => {};
const notOnServer = () => false;

/** a phone's head: its name · confirmation number · when last used · [이 폰 빼기] */
function PhoneHead({ phone, onRemove, disabled, buttonRef }: {
  phone: Phone; onRemove: () => void; disabled: boolean; buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const t = useTranslations('desktop.remoteDevices');
  const format = useFormatter();
  const used = phone.last_used_at ? format.relativeTime(new Date(phone.last_used_at), new Date()) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm font-medium">{phone.label}</span>
      <span className="text-xs text-muted-foreground" title={t('confirmNumberHint')}>{t('confirmNumber', { number: phone.confirm_number })}</span>
      {used ? <span className="text-xs text-muted-foreground">{t('lastUsed', { used })}</span> : null}
      <Button ref={buttonRef} size="sm" variant="outline" className="ml-auto" disabled={disabled} onClick={onRemove}>{t('removePhone')}</Button>
    </div>
  );
}

/** one pair under its phone: «짝: {computer}» · when paired · [빼기] (that pair only) */
function PairLine({ pair, onRemove, disabled, buttonRef }: {
  pair: Pair; onRemove: () => void; disabled: boolean; buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const t = useTranslations('desktop.remoteDevices');
  const format = useFormatter();
  const tz = useViewerTimeZone() ?? 'UTC';
  const date = format.dateTime(new Date(pair.paired_at), { ...deviceDateOptions(pair.paired_at, new Date(), tz), timeZone: tz });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm text-muted-foreground">{t('pairedWith', { device: pair.device_name ?? t('unknownDevice') })}</span>
      <span className="text-xs text-muted-foreground">{t('pairedOn', { date })}</span>
      <Button ref={buttonRef} size="sm" variant="outline" className="ml-auto" disabled={disabled} onClick={onRemove}>{t('remove')}</Button>
    </div>
  );
}

/** the in-line confirmation: the sentence · [빼기] (destructive) · [취소] focused first, as the remote-control card's */
function Confirm({ text, confirmLabel, onConfirm, onCancel }: { text: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('desktop.remoteDevices');
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2" role="group" aria-label={text}>
      <p className="text-sm">{text}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={onConfirm}>{confirmLabel ?? t('remove')}</Button>
        <Button size="sm" variant="outline" ref={cancelRef} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
