'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { useFlatHref } from '@/hooks/use-flat-href';
import { permissionLine, stillShown, waitedMinutes, type PermissionRequest } from '@/lib/agent-permissions';
import { isPhoneApp, phoneCall } from '@/lib/phone-bridge';
import { answerOnPhone, type AnswerOutcome } from '@/lib/phone-answer';

/**
 * story #4533 (E-DESKTOP-2 B-2 · 명세 모음 «B-2 폰 권한 요청 카드(웹은 읽기 전용)») — the approvals inbox's top group «에이전트 권한
 * 요청»: an agent waiting at a permission prompt on its computer, sent to the person who decides it. The web only looks (no device
 * key to sign with): the button place holds one line — the phone · the window passed · the computer gone quiet · no paired phone.
 * Read again every 15 s while a request is shown (the computer coming back or an answer from the phone changes the card), and at
 * once when a new one's bell notice arrives (PO 14:28Z).
 *
 * story #4532 (명세 B-2 · «폰 서명 · 권한 창 문구» ③ · design doc 0dceadda v3.1 ①) — inside the phone app only (the shell's
 * bridge was claimed at boot), an answerable request gets [허용] · [거부]: the web passes `{id, decision}` to the shell, which
 * reads the request from the server, asks the person on the OS prompt and signs; the result is one line in the button place.
 * A browser or the desktop app keeps the line above (no key to sign with). A card answered here stays with its result line while
 * the page is open (the list drops answered requests).
 */
const REFRESH_MS = 15_000;

/** How this phone confirms (the shell's `device.auth`) — `null` until known or outside the phone app. */
type PhoneAuth = 'biometric' | 'screen_lock' | 'biometric_required' | 'no_screen_lock';
type Answer = { kind: 'sending'; decision: 'allow' | 'deny' } | AnswerOutcome;

const noSubscribe = () => () => {};
const notOnServer = () => false;

const canConfirm = (auth: PhoneAuth) => auth === 'biometric' || auth === 'screen_lock';

/** Re-read how the phone confirms — on mount and when the person comes back (from the phone's settings). `onRead` hears each read. */
function usePhoneAuth(phone: boolean, onRead: (auth: PhoneAuth) => void): PhoneAuth | null {
  const [auth, setAuth] = useState<PhoneAuth | null>(null);
  const heard = useRef(onRead);
  useEffect(() => { heard.current = onRead; });
  useEffect(() => {
    if (!phone) return;
    let off = false;
    const read = () => void phoneCall('device.auth').then((a) => {
      if (off || !a.ok || typeof a.auth !== 'string') return;
      setAuth(a.auth as PhoneAuth);
      heard.current(a.auth as PhoneAuth);
    });
    read();
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off = true; document.removeEventListener('visibilitychange', onVisible); };
  }, [phone]);
  return phone ? auth : null;
}

async function readRequests(): Promise<PermissionRequest[] | null> {
  try {
    const res = await fetchWithAuth('/api/agent-permission-requests');
    if (!res.ok) return null;
    const body = (await res.json()) as { requests?: PermissionRequest[] };
    return Array.isArray(body.requests) ? body.requests : null;
  } catch {
    return null;
  }
}

export function AgentPermissionRequests() {
  const t = useTranslations('agentPermissions');
  const [requests, setRequests] = useState<PermissionRequest[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phone = useSyncExternalStore(noSubscribe, isPhoneApp, notOnServer);
  // answers given on this page: the card stays with its line (the server list drops an answered request)
  const [answers, setAnswers] = useState<ReadonlyMap<string, { row: PermissionRequest; answer: Answer }>>(new Map());
  // back from the phone's settings able to confirm: a «no fingerprint · no screen lock» answer gives its buttons back
  const auth = usePhoneAuth(phone, (now) => {
    if (!canConfirm(now)) return;
    setAnswers((m) => {
      const kept = [...m].filter(([, v]) => v.answer.kind !== 'biometric_required' && v.answer.kind !== 'no_screen_lock');
      return kept.length === m.size ? m : new Map(kept);
    });
  });
  const listed = (requests ?? []).filter((r) => stillShown(r, now));
  const shown = [...listed, ...[...answers.values()].filter((a) => !listed.some((r) => r.id === a.row.id)).map((a) => a.row)];
  const waiting = shown.length > 0;
  const [notices, setNotices] = useState(0);
  const readFor = useRef(-1);

  useSseNotifications({
    onNotification: (n) => {
      if (n.event_type === 'dispatched' && n.payload?.event_type === 'agent.permission_request') setNotices((k) => k + 1);
    },
  });

  // read on mount and on each new request's notice, then every 15 s while something is shown; a failed read keeps what was shown
  useEffect(() => {
    let off = false;
    const read = () => void readRequests().then((list) => {
      if (off) return;
      setRequests((prev) => list ?? prev ?? []);
      setNow(Date.now());
    });
    if (readFor.current !== notices) { readFor.current = notices; read(); }
    const id = waiting ? setInterval(read, REFRESH_MS) : null;
    return () => { off = true; if (id) clearInterval(id); };
  }, [waiting, notices]);

  const answer = async (row: PermissionRequest, decision: 'allow' | 'deny') => {
    const put = (a: Answer) => setAnswers((m) => new Map(m).set(row.id, { row, answer: a }));
    put({ kind: 'sending', decision });
    put(await answerOnPhone(row.id, decision, { phoneCall }));
  };

  if (shown.length === 0) return null; // nothing waiting: the inbox as it was

  return (
    <section className="mb-4 space-y-2" aria-labelledby="agent-permission-requests-title" data-testid="agent-permission-requests">
      <h2 id="agent-permission-requests-title" className="text-xs font-semibold text-muted-foreground">
        {t('groupTitle')} · {shown.length}
      </h2>
      {shown.map((r) => (
        <PermissionCard key={r.id} request={r} now={now} phone={phone} auth={auth} answer={answers.get(r.id)?.answer ?? null}
          onAnswer={(decision) => void answer(r, decision)} />
      ))}
    </section>
  );
}

function PermissionCard({ request: r, now, phone, auth, answer, onAnswer }: {
  request: PermissionRequest; now: number; phone: boolean; auth: PhoneAuth | null; answer: Answer | null;
  onAnswer: (decision: 'allow' | 'deny') => void;
}) {
  const t = useTranslations('agentPermissions');
  const line = permissionLine(r);
  const notes = [r.masked ? t('maskedNote') : null, r.truncated ? t('truncatedNote') : null].filter(Boolean);
  // the phone app answers here; everything else keeps the one read-only line
  const answersHere = phone && (answer !== null || (line === 'answerOnPhone' && r.state === 'pending' && r.answerable));
  return (
    <Card className="flex flex-col gap-1.5 px-4 py-3" data-testid="agent-permission-card">
      <div className="flex w-full flex-wrap items-center gap-1.5">
        {line === 'unknown' ? (
          <Badge variant="chip" className="border-dashed text-muted-foreground">{t('chipUnknown')}</Badge>
        ) : (
          <Badge variant="chip">{t('chip')}</Badge>
        )}
        {line === 'unknown' ? null : (
          <span className="text-[11px] text-muted-foreground">{t('waited', { n: waitedMinutes(r, now) })}</span>
        )}
      </div>
      <p className="text-sm text-foreground">{[r.agent_name, r.device_name].filter(Boolean).join(' · ')}</p>
      {r.role ? <p className="text-xs text-muted-foreground">{t('role', { role: r.role })}</p> : null}
      <p className="font-mono text-xs text-foreground">{r.tool}</p>
      <div className="rounded-md bg-muted/50 px-2 py-1.5">
        <p className="break-all font-mono text-xs text-foreground">{r.summary}</p>
        {notes.length > 0 ? <p className="mt-0.5 text-[11px] text-muted-foreground">{notes.join(' · ')}</p> : null}
      </div>
      {r.workdir ? <p className="text-[11px] text-muted-foreground">{t('workdir', { path: r.workdir })}</p> : null}
      {answersHere ? (
        <PhoneAnswerPlace tool={r.tool} auth={auth} answer={answer} onAnswer={onAnswer} />
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="agent-permission-line">
          {line === 'expired' ? t('line.expired')
            : line === 'unknown' ? t('line.unknown')
              : line === 'noPairedPhone' ? t('line.noPairedPhone')
                : t('line.answerOnPhone')}
        </p>
      )}
    </Card>
  );
}

/** The button place inside the phone app (명세 «폰 서명 · 권한 창 문구» ③ · B-2 결과 줄). */
function PhoneAnswerPlace({ tool, auth, answer, onAnswer }: {
  tool: string; auth: PhoneAuth | null; answer: Answer | null; onAnswer: (decision: 'allow' | 'deny') => void;
}) {
  const t = useTranslations('agentPermissions');
  const flat = useFlatHref();
  const a = answer;
  const pressed = a !== null; // a result after a press takes the focus the buttons had
  const buttons = (
    <div className="flex gap-2" data-testid="agent-permission-buttons">
      <Button size="sm" onClick={() => onAnswer('allow')}>{t('phone.allow')}</Button>
      <Button size="sm" variant="outline" onClick={() => onAnswer('deny')}>{t('phone.deny')}</Button>
    </div>
  );
  const settings = (
    <div><Button size="sm" variant="outline" onClick={() => void phoneCall('app.settings')}>{t('phone.openSettings')}</Button></div>
  );

  if (a === null) {
    if (auth === 'biometric_required' || auth === 'no_screen_lock') {
      return <><Line>{auth === 'no_screen_lock' ? t('phone.noScreenLock') : t('phone.biometricRequired')}</Line>{settings}</>;
    }
    return <>{buttons}{auth === 'screen_lock' ? <Line>{t('phone.screenLockConfirms')}</Line> : null}</>;
  }
  switch (a.kind) {
    case 'sending': return <Line focus>{t('phone.sending')}</Line>;
    case 'answered': return <Line focus>{a.decision === 'allow' ? t('phone.allowed', { tool }) : t('phone.denied', { tool })}</Line>;
    case 'answered_by':
      return <Line focus>{a.name && a.decision ? t(a.decision === 'allow' ? 'phone.allowedBy' : 'phone.deniedBy', { name: a.name }) : t('phone.answeredElsewhere')}</Line>;
    case 'closed': return <Line focus>{t('phone.closed')}</Line>;
    case 'expired': return <Line focus>{t('line.expired')}</Line>;
    case 'unreachable': return <Line focus>{t('line.unknown')}</Line>;
    case 'not_paired': return <Line focus>{t('phone.notPaired')}</Line>;
    case 'biometric_required': return <><Line focus>{t('phone.biometricRequired')}</Line>{settings}</>;
    case 'no_screen_lock': return <><Line focus>{t('phone.noScreenLock')}</Line>{settings}</>;
    case 'key_invalidated':
      return (
        <>
          <Line focus>{t('phone.keyInvalidated')}</Line>
          <div><Button size="sm" variant="outline" asChild><a href={flat('/desktop/pair')}>{t('phone.pairAgain')}</a></Button></div>
        </>
      );
    case 'cancelled': return <>{buttons}<Line focus={pressed}>{t('phone.cancelled')}</Line></>;
    default: return <>{buttons}<Line focus={pressed}>{t('phone.failed')}</Line></>;
  }
}

/** One line in the button place — a status; after a press it takes the focus (the buttons may be gone · as /desktop/remote). */
function Line({ focus = false, children }: { focus?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (focus) ref.current?.focus(); }, [focus, children]);
  return (
    <p ref={ref} tabIndex={-1} role="status" className="text-xs text-muted-foreground outline-none" data-testid="agent-permission-phone-line">
      {children}
    </p>
  );
}
