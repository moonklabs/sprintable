'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useFlatHref } from '@/hooks/use-flat-href';
import { isPhoneApp, phoneCall } from '@/lib/phone-bridge';
import { checkPairOffer, phoneLabel, scanPairQr, sendPairOffer, type OfferHead } from '@/lib/phone-pairing';

/**
 * story #4532 (명세 b0713c54 «짝짓기 화면 · 짝짓기 숫자 · 폰 확인 숫자» 폰 표 · contract 02d2cf71 §10 ⑤ v1.11 · design doc 0dceadda
 * v3.1 ④) — pairing this phone with a computer, inside the phone app. The shell reads the QR (its secret stays there) and makes
 * the MAC and the pairing number; this screen draws each step. Outside the phone app there is nothing to pair with (no key) — one
 * line says where to open it.
 * Steps: start → [QR 찍기] → «이 컴퓨터와 짝지을까요? · {computer}» → [짝짓기] → «컴퓨터 화면을 확인하는 중…» → the pairing number
 * (the computer took the offer) → «짝지었어요» (the pair stood on the computer). Waiting is read every 1.5 s up to the QR's time.
 */
const POLL_MS = 1_500;

type View =
  | { kind: 'start' }
  | { kind: 'busy' } // the camera or the server is working — no line yet
  | { kind: 'confirm'; head: OfferHead }
  | { kind: 'checking'; head: OfferHead; phoneKeyId: string }
  | { kind: 'number'; head: OfferHead; phoneKeyId: string; number: string }
  | { kind: 'paired'; device: string }
  | { kind: 'alreadyPaired' }
  | { kind: 'remoteOff' }
  | { kind: 'noScreenLock' | 'biometricRequired' }
  | { kind: 'limit' }
  | { kind: 'retry'; line: 'expired' | 'notOurs' | 'notPaired' | 'unreachable' | 'setupNotFound' | 'offerUsed' | 'registerAgain' | 'failed' };

const noSubscribe = () => () => {};
const notOnServer = () => false;

export function PhonePairing() {
  const t = useTranslations('phonePairing');
  const phone = useSyncExternalStore(noSubscribe, isPhoneApp, notOnServer);
  if (!phone) {
    return <Card className="break-keep p-6"><p className="text-sm text-muted-foreground">{t('notInApp')}</p></Card>;
  }
  return <Pairing />;
}

function Pairing() {
  const t = useTranslations('phonePairing');
  const tp = useTranslations('agentPermissions.phone');
  const flat = useFlatHref();
  const [view, setView] = useState<View>({ kind: 'start' });
  const [pressed, setPressed] = useState(false); // a line that follows a press takes the focus (the button is gone)
  const deps = { phoneCall };
  const known = useRef<string | null>(null);

  const scan = async () => {
    setPressed(true);
    setView({ kind: 'busy' });
    const r = await scanPairQr(deps);
    if (r.kind === 'confirm') setView({ kind: 'confirm', head: r.head });
    else if (r.kind === 'cancelled') setView({ kind: 'start' });
    else setView({ kind: 'retry', line: r.kind });
  };

  const pair = async (head: OfferHead) => {
    setView({ kind: 'busy' });
    const r = await sendPairOffer(head, phoneLabel(navigator.userAgent), deps);
    known.current = null;
    switch (r.kind) {
      case 'sent': setView({ kind: 'checking', head, phoneKeyId: r.phoneKeyId }); return;
      case 'alreadyPaired': case 'remoteOff': case 'limit': case 'noScreenLock': case 'biometricRequired': setView({ kind: r.kind }); return;
      default: setView({ kind: 'retry', line: r.kind });
    }
  };

  // waiting for the computer: one look every 1.5 s until the pair stands, the time runs out or the person cancels
  const waiting = view.kind === 'checking' || view.kind === 'number' ? view : null;
  const look = useCallback(async (w: { head: OfferHead; phoneKeyId: string }) => {
    if (Date.now() > Date.parse(w.head.expires_at) + POLL_MS * 2) return { kind: 'notPaired' } as const;
    return checkPairOffer(w.head, w.phoneKeyId, known.current, { phoneCall });
  }, []);
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

  const cancel = () => { known.current = null; setView({ kind: 'start' }); };
  // each refusal's line — one literal key per case (the i18n guards read literal keys)
  const retryLine = (line: RetryLine): string => {
    switch (line) {
      case 'expired': return t('expired');
      case 'notOurs': return t('notOurs');
      case 'notPaired': return t('notPaired');
      case 'unreachable': return t('unreachable');
      case 'setupNotFound': return t('setupNotFound');
      case 'offerUsed': return t('offerUsed');
      case 'registerAgain': return t('registerAgain');
      case 'failed': return t('failed');
    }
  };
  const settings = <Button variant="outline" onClick={() => void phoneCall('app.settings')}>{tp('openSettings')}</Button>;
  const rescan = <Button onClick={() => void scan()}>{t('rescan')}</Button>;
  const close = <Button variant="outline" asChild><a href={flat('/desktop')}>{t('close')}</a></Button>;

  switch (view.kind) {
    case 'start':
      return (
        <Shell>
          <p className="text-sm">{t('start')}</p>
          <Actions><Button onClick={() => void scan()}>{t('scan')}</Button></Actions>
        </Shell>
      );
    case 'busy':
      return <Shell><Loader2 className="size-4 animate-spin" aria-label={t('checking')} /></Shell>;
    case 'confirm':
      return (
        <Shell>
          <Line focus={pressed} strong>{t('confirm', { device: view.head.device_name })}</Line>
          <Actions>
            <Button onClick={() => void pair(view.head)}>{t('pair')}</Button>
            <Button variant="outline" onClick={cancel}>{t('cancel')}</Button>
          </Actions>
        </Shell>
      );
    case 'checking':
      return (
        <Shell>
          <Line focus>{t('checking')}</Line>
          <Actions><Button variant="outline" onClick={cancel}>{t('cancel')}</Button></Actions>
        </Shell>
      );
    case 'number':
      return (
        <Shell>
          {/* Yuna 07:48Z ②: three lines in the one status — the lead (small) · the number alone on its line · what to do with it */}
          <Line focus>
            <span className="block text-xs" data-testid="pairing-number-lead">{t('numberLead')}</span>
            <span className="block font-mono text-3xl font-semibold tracking-wider text-foreground" data-testid="pairing-number">{view.number}</span>
            <span className="block" data-testid="pairing-number-hint">{t('numberHint')}</span>
          </Line>
          <Actions><Button variant="outline" onClick={cancel}>{t('cancel')}</Button></Actions>
        </Shell>
      );
    case 'paired':
      return <Shell><Line focus>{t('paired', { device: view.device })}</Line><Actions>{close}</Actions></Shell>;
    case 'alreadyPaired':
      return <Shell><Line focus>{t('alreadyPaired')}</Line><Actions>{close}</Actions></Shell>;
    case 'remoteOff':
      return <Shell><Line focus>{t('remoteOff')}</Line><Actions>{close}</Actions></Shell>;
    case 'limit':
      return <Shell><Line focus>{t('limit')}</Line></Shell>;
    case 'noScreenLock':
    case 'biometricRequired':
      return (
        <Shell>
          <Line focus>{view.kind === 'noScreenLock' ? tp('noScreenLock') : tp('biometricRequired')}</Line>
          <Actions>{settings}{rescan}</Actions>
        </Shell>
      );
    case 'retry':
      return <Shell><Line focus={pressed}>{retryLine(view.line)}</Line><Actions>{rescan}</Actions></Shell>;
  }
}

type RetryLine = Extract<View, { kind: 'retry' }>['line'];

/** story #4532 — the entry on «원격 기기», only inside the phone app: this phone pairs from here (the shell has the camera and the key). */
export function PhonePairEntry() {
  const t = useTranslations('phonePairing');
  const flat = useFlatHref();
  return <div><Button size="sm" variant="outline" asChild><a href={flat('/desktop/pair')}>{t('entry')}</a></Button></div>;
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
      className={`${strong ? 'text-sm font-medium text-foreground' : 'text-sm text-muted-foreground'} break-keep text-pretty outline-none`}>
      {children}
    </p>
  );
}
