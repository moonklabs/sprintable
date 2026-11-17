'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/db/client';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { useFlatHref } from '@/hooks/use-flat-href';
import { usePairHref } from '@/hooks/use-pair-href';
import { RemoteControlLink, useRemoteOff } from '@/components/desktop/remote-off';
import { LimitPhoneRow, type LimitPhone } from '@/components/desktop/limit-phone-row';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET, phoneAppLinks } from '@/lib/phone-app-store';
import { QRCodeSVG } from 'qrcode.react';
import { checkPairOffer, cancelPairSession, comparePairSession, finishPairSession, lookPaired, lookPairSession, phoneLabel, revealPairSession, scanPairQr, sendPairCommit, sendPairOffer, type OfferHead } from '@/lib/phone-pairing';

/**
 * story #4532 (명세 b0713c54 «짝짓기 화면 · 짝짓기 숫자 · 폰 확인 숫자» 폰 표 · contract 02d2cf71 §10 ⑤ v1.11 · design doc 0dceadda
 * v3.1 ④) — pairing this phone with a computer, inside the phone app. The shell reads the QR (its secret stays there) and makes
 * the MAC and the pairing number; this screen draws each step. Outside the phone app there is nothing to pair with (no key) — one
 * line says where to open it.
 * Steps: start → [QR 찍기] → «이 컴퓨터와 짝지을까요? · {computer}» → [짝짓기] → «컴퓨터 화면을 확인하는 중…» → the pairing number
 * (the computer took the offer) → «짝지었어요» (the pair stood on the computer). Waiting is read every 1.5 s up to the QR's time.
 */
const POLL_MS = 1_500;
const FAILED_READS = 5; // reads of the server's state that fail in a row before the wait ends (story 4972 · lens 5842)

type View =
  | { kind: 'start' }
  | { kind: 'limitFull'; phones: LimitPhone[] | null; asking: string | null; freed: string | null }
  | { kind: 'busy' } // the camera or the server is working — no line yet
  | { kind: 'confirm'; head: OfferHead }
  | { kind: 'checking'; head: OfferHead; phoneKeyId: string }
  | { kind: 'number'; head: OfferHead; phoneKeyId: string; number: string }
  // story 4972 — the NEW pairing: after the commitment the computer's nonce is waited for (`bind`: the OS prompt is up / was closed), then both people compare the number in the SHELL's own window (the web never draws it), then the computer's own [같아요]
  | { kind: 'wait2'; head: OfferHead; phoneKeyId: string; bind: 'idle' | 'revealing' | 'cancelled' }
  | { kind: 'compare'; head: OfferHead; phoneKeyId: string; note: 'open' | 'closed' | 'notReady' | 'busy' | 'failed' } // the shell's window is up (open) · was closed with no answer
  | { kind: 'waitHost'; head: OfferHead; phoneKeyId: string }
  | { kind: 'paired'; device: string }
  | { kind: 'alreadyPaired'; device: string }
  | { kind: 'remoteOff' }
  | { kind: 'noScreenLock' | 'biometricRequired' }
  // story #4624 (Yuna): the limit and «another account» lines have [다시 찍기] under them (right after a phone is removed on the web)
  | { kind: 'retry'; line: 'expired' | 'notOurs' | 'notPaired' | 'unreachable' | 'setupNotFound' | 'offerUsed' | 'registerAgain' | 'limit' | 'taken' | 'takenOtherOrg' | 'notReady' | 'integrity' | 'receiptInvalid' | 'noReceipt' | 'qrUnreadable' | 'offerGone' | 'startedAlready' | 'forbidden' | 'signedOut' | 'serverUnreachable' | 'hostNo' | 'failed'; /** story 4695: the organization the phone is paired in (named by the server) */ org?: string };


/**
 * story 4654 (AC2): the phone app's store links, each with its QR (the address itself, from phone-app-store).
 * [SID:4671]: the link and «is the store open» are apart — Android draws the store when open, else the two-step way in (① the
 * testers' group page ② the internal-test opt-in page — two rows, each QR + link); iOS draws the store when open, else one «준비 중»
 * line (no link · no QR). Nothing to get at all → nothing drawn (phoneAppLinks · the page keeps its one line, story 4654 · Yuna 5048).
 */
export function PhoneAppGet({ body, scanHint = false }: { body?: string; scanHint?: boolean }) {
  const t = useTranslations('phonePairing');
  const links = phoneAppLinks(PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET);
  if (links.length === 0) return null;
  const row = (key: string, url: string, label: string, kind: string) => (
    <div key={key} className="flex items-center gap-3" data-testid={`phone-app-link-${key}`} data-kind={kind}>
      {/* Yuna 5060: the QR is decoration for a camera — the link's words are the row's name */}
      <QRCodeSVG value={url} size={72} aria-hidden="true" />
      <a className="inline-flex items-center text-ds-body text-ds-ink underline underline-offset-2 touch:min-h-11" href={url} target="_blank" rel="noreferrer">{label}</a>
    </div>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="phone-app-get">
      <p className="text-ds-body text-ds-ink">{t('getApp')}</p>
      {body ? <p className="text-ds-small text-ds-ink-3" data-testid="phone-app-body">{body}</p> : null}
      {/* Yuna §D (ux1-copy-1013): on a Mac, how the QR is used — right under the body, before the rows */}
      {scanHint ? <p className="text-ds-small text-ds-ink-3" data-testid="phone-app-scan-hint">{t('scanWithPhone')}</p> : null}
      {links.flatMap((l) => {
        if (l.kind === 'soon') return [<p key={l.store} className="text-ds-body text-ds-ink-3" data-testid="phone-app-ios-soon">{t('getAppIosSoon')}</p>];
        // Yuna §D: the two-step note right above the two rows — scanning ② alone is a dead end at Play until ① is joined
        if (l.kind === 'invite') return [
          <p key="android-note" className="text-ds-small text-ds-ink-3" data-testid="phone-app-invite-note">{t('getAppInviteNote')}</p>,
          row('android-group', l.group, t('getAppGroupJoin'), 'invite'),
          row('android', l.url, t('getAppAndroidInvite'), 'invite'),
        ];
        return [row(l.store, l.url, l.store === 'ios' ? t('getAppIos') : t('getAppAndroid'), 'store')];
      })}
    </div>
  );
}

export function PhonePairing({ returnTo = null }: { returnTo?: string | null } = {}) {
  const t = useTranslations('phonePairing');
  const { inPhoneApp: phone } = usePhoneBridge();
  if (!phone) {
    return (
      <Card className="break-keep flex flex-col gap-4 p-6">
        <p className="text-ds-body text-ds-ink-3">{t('notInApp')}</p>
        <PhoneAppGet />
      </Card>
    );
  }
  return <Pairing returnTo={returnTo} />;
}

function Pairing({ returnTo }: { returnTo: string | null }) {
  const { phoneCall } = usePhoneBridge();
  const t = useTranslations('phonePairing');
  const tp = useTranslations('agentPermissions.phone');
  const tr = useTranslations('desktop.remoteDevices');
  const flat = useFlatHref();
  const remoteOff = useRemoteOff(); // story #4583: who can turn it on — read now, shown only on the refusal
  const [view, setView] = useState<View>({ kind: 'start' });
  const [pressed, setPressed] = useState(false); // a line that follows a press takes the focus (the button is gone)
  const deps = { phoneCall };
  const known = useRef<string | null>(null);
  // a pairing's generation: bumped when it is left (cancel · a new start · the screen goes away) — a late answer of an OLDER pairing's shell call does nothing. (The reveal step cannot use the effect's own `off`: the view changes to «revealing» while the OS prompt is up, which re-runs the effect.)
  const gen = useRef(0);
  useEffect(() => () => { gen.current += 1; }, []);

  const scan = async () => {
    gen.current += 1;
    failedReads.current = 0;
    setPressed(true);
    setView({ kind: 'busy' });
    const r = await scanPairQr(deps);
    if (r.kind === 'confirm') setView({ kind: 'confirm', head: r.head });
    else if (r.kind === 'cancelled') setView({ kind: 'start' });
    else setView({ kind: 'retry', line: r.kind });
  };

  const pair = async (head: OfferHead) => {
    setView({ kind: 'busy' });
    gen.current += 1; // a new pairing starts: a late answer of an older one does nothing
    failedReads.current = 0;
    const g = gen.current;
    // the procedure is the scanned QR's version and nothing else (story 4972): a v2 QR pairs the new way, any other the old way as it always did
    const r = head.version === 2 ? await sendPairCommit(head, phoneLabel(navigator.userAgent), { phoneCall, alive: () => gen.current === g }) : await sendPairOffer(head, phoneLabel(navigator.userAgent), deps);
    if (gen.current !== g) return; // left meanwhile (the commit step has its own guard: nothing went to the server)
    known.current = null;
    switch (r.kind) {
      case 'sent': setView(head.version === 2 ? { kind: 'wait2', head, phoneKeyId: r.phoneKeyId, bind: 'idle' } : { kind: 'checking', head, phoneKeyId: r.phoneKeyId }); return;
      case 'alreadyPaired': setView({ kind: 'alreadyPaired', device: head.device_name }); return; // story 4932: the computer is named
      case 'remoteOff': case 'noScreenLock': case 'biometricRequired': setView({ kind: r.kind }); return;
      case 'notReady': setView({ kind: 'retry', line: 'notReady' }); return;
      case 'limit': void enterLimit(); return;
      case 'takenOtherOrg': setView({ kind: 'retry', line: 'takenOtherOrg', ...(r.org ? { org: r.org } : {}) }); return;
      default: setView({ kind: 'retry', line: r.kind });
    }
  };

  // waiting for the computer: one look every 1.5 s until the pair stands, the time runs out or the person cancels
  const waiting = view.kind === 'checking' || view.kind === 'number' ? view : null;
  const look = useCallback(async (w: { head: OfferHead; phoneKeyId: string }) => {
    if (Date.now() > Date.parse(w.head.expires_at) + POLL_MS * 2) return { kind: 'notPaired' } as const;
    return checkPairOffer(w.head, w.phoneKeyId, known.current, { phoneCall });
  }, [phoneCall]);
  useEffect(() => {
    if (!waiting) return;
    let off = false;
    const id = setTimeout(() => void look(waiting).then((r) => {
      if (off) return;
      if (r.kind === 'number') {
        known.current = r.number;
        setView({ kind: 'number', head: waiting.head, phoneKeyId: waiting.phoneKeyId, number: r.number });
      } else if (r.kind === 'paired') setView({ kind: 'paired', device: waiting.head.device_name });
      else if (r.kind === 'notPaired') setView({ kind: 'retry', line: 'notPaired' });
      else setView({ ...waiting }); // waiting · a failed read: look again
    }), POLL_MS);
    return () => { off = true; clearTimeout(id); };
  }, [waiting, look]);

  // story 4972 — the new pairing's waits: (1) the computer's nonce → the shell checks it, the person confirms on the OS prompt, the reveal goes up, the number shows; (2) after this phone's [같아요], the computer's own
  const wait2 = view.kind === 'wait2' && view.bind === 'idle' ? view : null;
  // a read of the server's state that failed is tried again — a few times: «signed out» and «remote control off» are said as what they are, and after FAILED_READS in a row the wait ends with a line (never a silent five minutes)
  const failedReads = useRef(0);
  const readFailure = (why: 'signedOut' | 'remoteOff' | 'forbidden' | undefined): 'wait' | RetryLine | 'remoteOff' => {
    failedReads.current += 1;
    if (why === 'remoteOff') return 'remoteOff';
    if (why === 'signedOut') return 'signedOut';
    if (why === 'forbidden') return 'forbidden';
    return failedReads.current >= FAILED_READS ? 'serverUnreachable' : 'wait'; // (the read that failed is the PHONE's to the server — not the computer being unreachable)
  };
  // the pairing ends with a line: the shell drops this offer (and a provisional pin, and an open number window), the server's offer ends too
  const endWith = (head: OfferHead, how: RetryLine | 'remoteOff'): void => {
    const g = gen.current;
    // the shell may answer «pinning» (the real pin is being written this very moment — the computer's person had confirmed): then the pairing is DONE and the line is replaced, never an error over a finished pairing
    void cancelPairSession(head, deps).then((r) => { if (r.pinning && gen.current === g) setView((v) => (v.kind === 'retry' || v.kind === 'remoteOff' ? { kind: 'paired', device: head.device_name } : v)); });
    known.current = null;
    setView(how === 'remoteOff' ? { kind: 'remoteOff' } : { kind: 'retry', line: how });
  };
  useEffect(() => {
    if (!wait2) return;
    let off = false;
    const id = setTimeout(() => void (async () => {
      if (Date.now() > Date.parse(wait2.head.expires_at) + POLL_MS * 2) { if (!off) endWith(wait2.head, 'notPaired'); return; }
      const look = await lookPairSession(wait2.head);
      if (off) return;
      if (look.kind === 'failed') { const how = readFailure(look.why); if (how === 'wait') setView({ ...wait2 }); else endWith(wait2.head, how); return; }
      failedReads.current = 0;
      if (look.kind === 'gone') { endWith(wait2.head, 'offerGone'); return; }
      if (look.kind === 'ended') { endWith(wait2.head, 'notPaired'); return; }
      if (look.kind === 'revealed') { setView({ kind: 'compare', head: wait2.head, phoneKeyId: wait2.phoneKeyId, note: 'open' }); return; } // revealed already (an answer was lost on the way back): the shell holds the number
      if (look.kind !== 'nonce') { setView({ ...wait2 }); return; } // waiting: look again
      const g = gen.current;
      setView({ ...wait2, bind: 'revealing' }); // the OS prompt is up: not asked again meanwhile (one reveal)
      const r = await revealPairSession(wait2.head, look, { phoneCall, alive: () => gen.current === g });
      if (gen.current !== g) return; // left meanwhile (cancel · a new start · gone)
      switch (r.kind) {
        case 'revealed': setView({ kind: 'compare', head: wait2.head, phoneKeyId: wait2.phoneKeyId, note: 'open' }); return;
        case 'cancelled': setView({ ...wait2, bind: 'cancelled' }); return; // the person closed the prompt: the same nonce may be tried again with [다시 확인]
        case 'ended': endWith(wait2.head, 'notPaired'); return;
        case 'offerGone': endWith(wait2.head, 'offerGone'); return;
        case 'integrity': endWith(wait2.head, 'integrity'); return; // the computer's answer did not fit its key: its own line (not a time-out)
        case 'expired': endWith(wait2.head, 'expired'); return;
        case 'noScreenLock': case 'biometricRequired': void cancelPairSession(wait2.head, deps); setView({ kind: r.kind }); return; // (the shell's offer is dropped too: nothing is left half-open)
        default: endWith(wait2.head, 'failed');
      }
    })(), POLL_MS);
    return () => { off = true; clearTimeout(id); };
  }, [wait2, phoneCall]);

  // after this phone's person agreed (a provisional pin in the shell): the computer's person must press [같아요] too — the page sees the pair on the server's list and asks the shell to make the pin real (the shell reads the list itself)
  const waitHost = view.kind === 'waitHost' ? view : null;
  useEffect(() => {
    if (!waitHost) return;
    let off = false;
    const id = setTimeout(() => void (async () => {
      // the pairing is over without a result the page itself saw (the window ran out, or the server says the offer ended): ask the shell ONCE what became of it — it may have made the pin real by itself (then it is paired), and a computer that said it sends a
      // confirmation and sent none (or a bad one) has its own line, not «you did not press». Only then the old «not finished on the computer» line.
      const lastWord = async () => {
        const last = await finishPairSession(waitHost.head, { phoneCall });
        if (off) return;
        switch (last.kind) {
          case 'pinned': setView({ kind: 'paired', device: waitHost.head.device_name }); return;
          case 'alreadyPaired': setView({ kind: 'alreadyPaired', device: waitHost.head.device_name }); return;
          case 'receiptInvalid': endWith(waitHost.head, 'receiptInvalid'); return;
          case 'noReceipt': endWith(waitHost.head, 'noReceipt'); return;
          case 'signedOut': endWith(waitHost.head, 'signedOut'); return;
          default: endWith(waitHost.head, 'hostNo');
        }
      };
      if (Date.now() > Date.parse(waitHost.head.expires_at) + POLL_MS * 2) { if (!off) await lastWord(); return; }
      const found = await lookPaired(waitHost.head, waitHost.phoneKeyId);
      if (off) return;
      if (typeof found === 'object') { const how = readFailure(found.failed === 'read' ? undefined : found.failed); if (how === 'wait') setView({ ...waitHost }); else endWith(waitHost.head, how); return; } // (a failed read of the list: counted like any failed read)
      if (found === 'paired') {
        failedReads.current = 0; // (the list read and the answer of the shell are what count here — no second read follows)
        const f = await finishPairSession(waitHost.head, { phoneCall });
        if (off) return;
        switch (f.kind) {
          case 'pinned': setView({ kind: 'paired', device: waitHost.head.device_name }); return;
          case 'alreadyPaired': setView({ kind: 'alreadyPaired', device: waitHost.head.device_name }); return;
          case 'expired': endWith(waitHost.head, 'expired'); return;
          case 'signedOut': endWith(waitHost.head, 'signedOut'); return;
          case 'receiptInvalid': endWith(waitHost.head, 'receiptInvalid'); return;
          case 'noReceipt': endWith(waitHost.head, 'noReceipt'); return;
          case 'failed': endWith(waitHost.head, 'failed'); return;
          default: setView({ ...waitHost }); return; // not yet · the key store is busy: look again
        }
      }
      const look = await lookPairSession(waitHost.head);
      if (off) return;
      if (look.kind === 'failed') { const how = readFailure(look.why); if (how === 'wait') setView({ ...waitHost }); else endWith(waitHost.head, how); return; }
      failedReads.current = 0;
      if (look.kind === 'gone') { endWith(waitHost.head, 'offerGone'); return; }
      if (look.kind === 'ended') { await lastWord(); return; } // the computer's person said «different» (or the window ended): the shell is asked once what became of it, then drops what it held
      setView({ ...waitHost });
    })(), POLL_MS);
    return () => { off = true; clearTimeout(id); };
  }, [waitHost, phoneCall]);

  // the shell's own window opens once per `open` (the web only asks; the number and the buttons are the shell's)
  const compare = view.kind === 'compare' && view.note === 'open' ? view : null;
  useEffect(() => {
    if (!compare) return;
    let off = false;
    void (async () => {
      const r = await comparePairSession(compare.head, { phoneCall });
      if (off) return;
      switch (r.kind) {
        case 'agreed': setView({ kind: 'waitHost', head: compare.head, phoneKeyId: compare.phoneKeyId }); return;
        case 'declined': known.current = null; setView({ kind: 'start' }); return;
        case 'closed': setView({ ...compare, note: 'closed' }); return; // no answer: [숫자 다시 보기]
        case 'expired': setView({ kind: 'retry', line: 'expired' }); return;
        case 'notReady': setView({ ...compare, note: 'notReady' }); return;
        case 'busy': setView({ ...compare, note: 'busy' }); return;
        default: setView({ ...compare, note: 'failed' });
      }
    })();
    return () => { off = true; };
  }, [compare, phoneCall]);
  // a cancel while a new pairing is under way ends the offer at the server (the shell's copy ends with its own window — at most 10 minutes)
  const abandon = (v: { head: OfferHead }) => {
    const g = ++gen.current;
    // the shell may answer «pinning» (the real pin is being written this very moment: the computer's person has already confirmed) — then the pairing is DONE, not cancelled
    void cancelPairSession(v.head, deps).then((r) => { if (r.pinning && gen.current === g) setView({ kind: 'paired', device: v.head.device_name }); });
    known.current = null; setView({ kind: 'start' });
  };

  // story #4624 — the limit screen: the person's phones, one confirm to remove one, then the rescan
  const loadLimitPhones = async () => {
    try {
      const res = await fetchWithAuth('/api/remote-devices');
      const body = res.ok ? ((await res.json()) as { devices?: LimitPhone[] }) : null;
      setView((v) => (v.kind === 'limitFull' ? { ...v, phones: Array.isArray(body?.devices) ? body.devices : [] } : v));
    } catch {
      setView((v) => (v.kind === 'limitFull' ? { ...v, phones: [] } : v));
    }
  };
  const enterLimit = async () => {
    setView({ kind: 'limitFull', phones: null, asking: null, freed: null });
    await loadLimitPhones();
  };
  const removeLimitPhone = async (phone: LimitPhone) => {
    try {
      const res = await fetchWithAuth(`/api/remote-devices/${phone.id}`, { method: 'DELETE' });
      setView({ kind: 'limitFull', phones: null, asking: null, freed: res.ok ? phone.label : null });
    } catch {
      setView((v) => (v.kind === 'limitFull' ? { ...v, asking: null } : v));
    }
    await loadLimitPhones();
  };

  const cancel = () => { known.current = null; setView({ kind: 'start' }); };
  // each refusal's line — one literal key per case (the i18n guards read literal keys)
  const retryLine = (line: RetryLine, org?: string): string => {
    switch (line) {
      case 'expired': return t('expired');
      case 'notOurs': return t('notOurs');
      case 'notPaired': return t('notPaired');
      case 'unreachable': return t('unreachable');
      case 'setupNotFound': return t('setupNotFound');
      case 'offerUsed': return t('offerUsed');
      case 'registerAgain': return t('registerAgain');
      case 'integrity': return t('integrity');
      case 'offerGone': return t('offerGone');
      case 'startedAlready': return t('startedAlready');
      case 'forbidden': return t('forbidden');
      case 'signedOut': return t('signedOut');
      case 'serverUnreachable': return t('serverUnreachable');
      case 'receiptInvalid': return t('receiptInvalid');
      case 'noReceipt': return t('noReceipt');
      case 'qrUnreadable': return t('qrUnreadable');
      case 'hostNo': return t('hostNo');
      case 'limit': return t('limit.title');
      case 'taken': return t('taken');
      case 'takenOtherOrg': return org ? t('takenOtherOrgNamed', { org }) : t('takenOtherOrg');
      case 'notReady': return t('notReady');
      case 'failed': return t('failed');
    }
  };
  const settings = <Button variant="secondary" onClick={() => void phoneCall('app.settings')}>{tp('openSettings')}</Button>;
  const rescan = <Button variant="primary" onClick={() => void scan()}>{t('rescan')}</Button>;
  // story 4780: [Close] goes back where the pairing was started from (`returnTo` is the entry's page, checked by the page); with none it is the Mac screen as it always was
  const close = <Button variant="secondary" asChild><a href={flat(returnTo ?? '/desktop')}>{t('close')}</a></Button>;

  switch (view.kind) {
    case 'start':
      return (
        <Shell>
          <p className="text-ds-body text-ds-ink">{t('start')}</p>
          <Actions><Button variant="primary" onClick={() => void scan()}>{t('scan')}</Button></Actions>
        </Shell>
      );
    case 'busy':
      return <Shell><Loader2 className="size-4 animate-spin" aria-label={t('checking')} /></Shell>;
    case 'confirm':
      return (
        <Shell>
          <Line focus={pressed} strong>{t('confirm', { device: view.head.device_name })}</Line>
          <Actions>
            <Button variant="primary" onClick={() => void pair(view.head)}>{t('pair')}</Button>
            <Button variant="secondary" onClick={cancel}>{t('cancel')}</Button>
          </Actions>
        </Shell>
      );
    case 'checking':
      return (
        <Shell>
          <Line focus>{t('checking')}</Line>
          <Actions><Button variant="secondary" onClick={cancel}>{t('cancel')}</Button></Actions>
        </Shell>
      );
    case 'number':
      return (
        <Shell>
          {/* Yuna 07:48Z ②: three lines in the one status — the lead (small) · the number alone on its line · what to do with it */}
          <Line focus>
            <span className="block text-ds-small" data-testid="pairing-number-lead">{t('numberLead')}</span>
            <span className="block font-mono text-display font-semibold tracking-wider text-ds-ink" data-testid="pairing-number">{view.number}</span>
            <span className="block" data-testid="pairing-number-hint">{t('numberHint')}</span>
          </Line>
          <Actions><Button variant="secondary" onClick={cancel}>{t('cancel')}</Button></Actions>
        </Shell>
      );
    case 'wait2':
      return (
        <Shell>
          <Line focus>{view.bind === 'cancelled' ? t('bindCancelled') : t('checking')}</Line>
          <Actions>
            {view.bind === 'cancelled' ? <Button variant="primary" onClick={() => setView({ ...view, bind: 'idle' })}>{t('bindAgain')}</Button> : null}
            <Button variant="secondary" onClick={() => abandon(view)}>{t('cancel')}</Button>
          </Actions>
        </Shell>
      );
    case 'compare':
      return (
        <Shell>
          {/* the number and the two buttons are in the phone app's own window (never drawn here: this page comes from the server) */}
          <Line focus>{view.note === 'open' ? t('compareOpen') : view.note === 'notReady' ? t('notReady') : view.note === 'busy' ? t('compareBusy') : view.note === 'failed' ? t('failed') : t('compareClosed')}</Line>
          <Actions>
            {view.note !== 'open' ? <Button variant="primary" onClick={() => setView({ ...view, note: 'open' })}>{t('compareAgain')}</Button> : null}
            <Button variant="secondary" onClick={() => abandon(view)}>{t('cancel')}</Button>
          </Actions>
        </Shell>
      );
    case 'waitHost':
      return (
        <Shell>
          <Line focus>{t('waitHost')}</Line>
          <Actions><Button variant="secondary" onClick={() => abandon(view)}>{t('cancel')}</Button></Actions>
        </Shell>
      );
    case 'paired':
      return <Shell><Line focus>{t('paired', { device: view.device })}</Line><Actions>{close}</Actions></Shell>;
    case 'alreadyPaired':
      return <Shell><Line focus>{t('alreadyPaired', { device: view.device })}</Line><Actions>{close}</Actions></Shell>;
    case 'remoteOff':
      // story #4583 (Yuna copy.md row 1): the owner gets the way to the switch (and may still close) · anyone else the owner's name
      if (remoteOff?.owner) return <Shell><Line focus>{t('remoteOffOwner')}</Line><Actions><RemoteControlLink variant="button" />{close}</Actions></Shell>;
      return <Shell><Line focus>{t('remoteOffOthers', remoteOff?.names ?? { owners: '', hasOwners: 'no' })}</Line><Actions>{close}</Actions></Shell>;
    case 'noScreenLock':
    case 'biometricRequired':
      return (
        <Shell>
          {/* story 4932: this is a refusal BEFORE anything was sent (the phone's key cannot be made without a screen lock / a fingerprint) — it was read as the pairing's result. So it says first that nothing is paired
              yet and nothing was sent, then what to do, then that the QR lives only 5 minutes (setting a lock takes a while — the same QR is often gone by the time the person comes back). */}
          <Line focus>{t('notSentYet')}</Line>
          <Line>{view.kind === 'noScreenLock' ? tp('noScreenLock') : tp('biometricRequired')}</Line>
          <Line>{t('qrFiveMinutes')}</Line>
          <Actions>{settings}{rescan}</Actions>
        </Shell>
      );
    case 'limitFull': {
      const phones = view.phones;
      return (
        <Shell>
          <Line focus>{t('limit.title')}</Line>
          <Line>{t('limit.why')}</Line>
          <Line>{t('limit.todo')}</Line>
          <p className="text-ds-small text-ds-ink-3">{t('limit.listHead')}</p>
          {phones === null ? <Loader2 className="size-4 animate-spin" aria-label={t('checking')} /> : (
            <ul className="flex flex-col gap-3">
              {phones.map((p) => (
                <LimitPhoneRow
                  key={p.id}
                  phone={p}
                  asking={view.asking === p.id}
                  onAsk={() => setView({ ...view, asking: p.id })}
                  onConfirm={() => void removeLimitPhone(p)}
                  onCancel={() => setView({ ...view, asking: null })}
                />
              ))}
            </ul>
          )}
          {view.freed ? <Line>{tr('phoneRemoved', { phone: view.freed })}</Line> : null}
          {view.freed ? <Line>{t('limit.after')}</Line> : null}
          <Actions>{rescan}<a href={flat('/desktop')} className="inline-flex items-center text-ds-body text-ds-ink underline underline-offset-2 touch:min-h-11" data-testid="pairing-limit-web-link">{t('limit.webLink')}</a></Actions>
        </Shell>
      );
    }
    case 'retry':
      return <Shell><Line focus={pressed}>{retryLine(view.line, view.org)}</Line><Actions>{rescan}</Actions></Shell>;
  }
}

type RetryLine = Extract<View, { kind: 'retry' }>['line'];

/** story #4532 — the entry on «원격 기기», only inside the phone app: this phone pairs from here (the shell has the camera and the key). */
export function PhonePairEntry() {
  const t = useTranslations('phonePairing');
  const pairHref = usePairHref();
  return <div><Button variant="secondary" asChild><a href={pairHref}>{t('entry')}</a></Button></div>;
}

function Shell({ children }: { children: ReactNode }) {
  return <Card className="break-keep flex flex-col gap-3 p-6" data-testid="phone-pairing">{children}</Card>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

/** A step's line — a status; after a press it takes the focus the vanished button had (as /desktop/remote · Yuna 10:28Z). */
function Line({ focus = false, strong = false, children }: { focus?: boolean; strong?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (focus) ref.current?.focus(); }, [focus]);
  return (
    <p ref={ref} tabIndex={-1} role="status" data-testid="phone-pairing-line"
      className={`${strong ? 'text-ds-body font-medium text-ds-ink' : 'text-ds-body text-ds-ink-3'} break-keep text-pretty outline-none`}>
      {children}
    </p>
  );
}
