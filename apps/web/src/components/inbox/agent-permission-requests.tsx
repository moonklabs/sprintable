'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { useFlatHref } from '@/hooks/use-flat-href';
import { agentOnDevice, permissionLine, requestAge, shownToolName, stillShown, type PermissionRequest } from '@/lib/agent-permissions';
import { isPhoneApp, phoneCall } from '@/lib/phone-bridge';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';
import { answerOnPhone, type AnswerOutcome } from '@/lib/phone-answer';
import { RemoteControlLink, useRemoteOff } from '@/components/desktop/remote-off';

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
// PO 11:23Z ③(나): with nothing shown the list is read again on this slower clock too — the request's notice alone did not reach the
// phone app's page (dev E2E: an empty list stayed empty until the tab was left and opened again), as the bell polls besides its stream
const EMPTY_REFRESH_MS = 30_000;

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
  const remoteOff = useRemoteOff(); // story #4583: why none come — only while off and with a connected computer
  const [requests, setRequests] = useState<PermissionRequest[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phone = useSyncExternalStore(noSubscribe, isPhoneApp, notOnServer);
  // answers given on this page: the card stays with its line until the next read (story #4596 — the list is what waits; `at` = when its
  // answer was given)
  const [answers, setAnswers] = useState<ReadonlyMap<string, Kept>>(new Map());
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
    // story #4607: the server sends a person's notice as a NAMED frame (`event: dispatched` — backend routers/events.py, backfill and
    // live), which the hook's default names and the unnamed `message` never receive — so a new request's notice never read the list
    // here (the card came by the 15 s poll: 0.76 s / 9.1 s measured). Subscribed by name now.
    extraEventNames: ['dispatched'],
    onExtraEvent: (_name, data) => {
      const d = data as { payload?: { event_type?: unknown } | null } | null;
      if (d?.payload?.event_type === 'agent.permission_request') setNotices((k) => k + 1);
    },
  });

  // read on mount and on each new request's notice, then every 15 s while something is shown (30 s while nothing is) and whenever the
  // page is seen again (back to the app); a failed read keeps what was shown
  useEffect(() => {
    let off = false;
    let pending = false;
    const read = () => {
      pending = true;
      const started = Date.now();
      void readRequests().then((list) => {
        pending = false;
        if (off) return;
        setRequests((prev) => list ?? prev ?? []);
        // story #4596 AC1: a card answered here leaves at the first read made after its answer that no longer lists it — a page kept
        // open through many answers never holds them (a failed read keeps what was shown)
        if (list) setAnswers((m) => afterRead(m, list, started));
        setNow(Date.now());
      });
    };
    if (readFor.current !== notices) { readFor.current = notices; read(); }
    const id = setInterval(read, waiting ? REFRESH_MS : EMPTY_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    // a read this run started and its cleanup now drops was never read — the next run reads again (React's development mode runs
    // each effect twice at mount: the first read was dropped and the list stayed empty for good — the iOS · Android dev runs)
    return () => { off = true; if (pending) readFor.current = -1; clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [waiting, notices]);

  const answer = async (row: PermissionRequest, decision: 'allow' | 'deny') => {
    const put = (a: Answer) => setAnswers((m) => new Map(m).set(row.id, { row, answer: a, at: Date.now() }));
    put({ kind: 'sending', decision });
    put(await answerOnPhone(row.id, decision, { phoneCall }));
  };

  // story #4583 (Yuna copy.md row 4): while remote control is off no request reaches the server, so the list is empty without a word —
  // one muted line says why, above the list (web and the phone's approvals list are this component). Only with a connected computer:
  // an org that never connected one gets no line (it would be noise).
  const offLine = remoteOff && remoteOff.connectedComputers > 0 ? (
    <div className="mb-4 flex flex-col gap-1" data-testid="agent-permission-remote-off">
      <p className="break-keep text-sm text-muted-foreground">
        {remoteOff.owner ? t('remoteOffOwner') : t('remoteOffOthers', remoteOff.names)}
      </p>
      {remoteOff.owner ? <RemoteControlLink /> : null}
    </div>
  ) : null;

  if (shown.length === 0) return offLine; // nothing waiting: the inbox as it was (+ the off line)

  return (
    <>
    {offLine}
    <section className="mb-4 space-y-2" aria-labelledby="agent-permission-requests-title" data-testid="agent-permission-requests">
      <h2 id="agent-permission-requests-title" className="text-xs font-semibold text-muted-foreground">
        {t('groupTitle')} · {shown.length}
      </h2>
      {shown.map((r) => (
        <PermissionCard key={`${r.id}:${r.stage ?? 'ask'}`} request={r} now={now} phone={phone} auth={auth} answer={answerFor(answers, r)}
          onAnswer={(decision) => void answer(r, decision)} />
      ))}
    </section>
    </>
  );
}

/** story 4580: the daemon's value for Claude's sandbox network question (sprintable-mobile desktop-host · tool-names.json) */
const SANDBOX_NET_TOOL = 'SandboxNetwork';

type Kept = { row: PermissionRequest; answer: Answer; at: number };
/** story #4596: the network question's first «allow…» — the request comes back (its second card · or «주소를 확인하지 못해…») a few
 *  seconds later; its card waits for that, never more than this */
const NET_FIRST_ALLOW_KEEP_MS = 2 * 60 * 1000;

/** story #4596 AC1: what stays of the answers given here after a read that started at `started` — one the read still lists is shown from
 *  the list anyway; one it no longer lists leaves, once the read was made after its answer. Kept: an answer still on its way, and the
 *  network question's first «allow…» until its request is listed again (at most NET_FIRST_ALLOW_KEEP_MS) */
export function afterRead(m: ReadonlyMap<string, Kept>, list: readonly PermissionRequest[], started: number, now = Date.now()): ReadonlyMap<string, Kept> {
  const listed = new Set(list.map((r) => r.id));
  const kept = [...m].filter(([id, k]) => {
    if (listed.has(id) || k.answer.kind === 'sending' || started < k.at) return true;
    const netFirstAllow = k.row.tool === SANDBOX_NET_TOOL && (k.row.stage ?? 'ask') === 'ask' && k.answer.kind === 'answered' && k.answer.decision === 'allow';
    return netFirstAllow && now - k.at < NET_FIRST_ALLOW_KEEP_MS;
  });
  return kept.length === m.size ? m : new Map(kept);
}

/** story #4596 AC2: «{n}분째 기다림» only on a card that still waits — pending, and not just answered here */
export function stillWaiting(r: PermissionRequest, answer: Answer | null): boolean {
  if (r.state !== 'pending') return false;
  return !(answer && (answer.kind === 'sending' || answer.kind === 'answered' || answer.kind === 'answered_by' || answer.kind === 'expired' || answer.kind === 'closed'));
}

/** story #4580 AC2: an answer given here belongs to the stage it was given at — the first «allow…» never stands on the second card */
function answerFor(answers: ReadonlyMap<string, Kept>, r: PermissionRequest): Answer | null {
  const a = answers.get(r.id);
  return a && (a.row.stage ?? 'ask') === (r.stage ?? 'ask') ? a.answer : null;
}

function PermissionCard({ request: r, now, phone, auth, answer, onAnswer }: {
  request: PermissionRequest; now: number; phone: boolean; auth: PhoneAuth | null; answer: Answer | null;
  onAnswer: (decision: 'allow' | 'deny') => void;
}) {
  const t = useTranslations('agentPermissions');
  const locale = useLocale();
  const tool = shownToolName(r, locale); // story 4542: the server's name by the one rule (never the machine value from a known table)
  const line = permissionLine(r);
  const notes = [r.masked ? t('maskedNote') : null, r.truncated ? t('truncatedNote') : null].filter(Boolean);
  // the phone app answers here; everything else keeps the one read-only line
  const answersHere = phone && (answer !== null || (line === 'answerOnPhone' && r.state === 'pending' && r.answerable));
  // story #4580 AC2 (Yuna «4580 AC2» ① ② · 배치 ① ②): the network question — first with no host, then its second state with the host
  const net = r.tool === SANDBOX_NET_TOOL && r.runtime === 'claude' ? (r.stage === 'confirm' && r.host ? 'confirm' : 'ask') : null;
  // story #4604 (Yuna · 4596 AC4 run 13b): the question's own words — «press [Allow…]» · «{host}에 연결하려고 해요» — only while it
  // still asks (the waiting chip's rule): an answered · expired · withdrawn card keeps the tool name and its result line, never an
  // instruction with no button under it. A press that came back (cancelled · failed) brings the buttons back, and the words with them
  const asking = stillWaiting(r, answer);
  return (
    <Card className="flex flex-col gap-1.5 px-4 py-3" data-testid="agent-permission-card">
      <div className="flex w-full flex-wrap items-center gap-1.5">
        {line === 'unknown' ? (
          <Badge variant="chip" className="border-dashed text-muted-foreground">{t('chipUnknown')}</Badge>
        ) : (
          <Badge variant="chip">{t('chip')}</Badge>
        )}
        {line !== 'unknown' && asking ? (
          <span className="text-[11px] text-muted-foreground" data-testid="agent-permission-waited">{t('waited', requestAge(r, now))}</span>
        ) : (
          // story #4610 (run13b 20:45Z): every other card says when it was asked, in the chip's place — answered · expired · withdrawn
          // cards stay a while (#4596) and several of one agent looked alike: which question a result belongs to is this time
          <span className="text-[11px] text-muted-foreground" data-testid="agent-permission-asked">{t('asked', requestAge(r, now))}</span>
        )}
      </div>
      <p className="text-sm text-foreground">{agentOnDevice(r.agent_name, r.device_name)}</p>
      {r.role ? <p className="text-xs text-muted-foreground">{t('role', { role: r.role })}</p> : null}
      {/* story #4590 (Yuna §1): a terminal-only question whose tool was not read — where to see it, never a made-up name */}
      {tool !== null ? <p className="text-xs text-foreground" data-testid="agent-permission-tool">{tool}</p>
        : <p className="break-keep text-pretty text-xs text-muted-foreground" data-testid="agent-permission-tool-unread">{t('toolUnread')}</p>}
      {net === 'confirm' ? (!asking ? null :
        <div className="space-y-1" data-testid="agent-permission-net-confirm">
          <p className="break-keep text-sm font-medium text-foreground [overflow-wrap:anywhere]">{t('net.confirmTitle', { host: r.host ?? '' })}</p>
          <p className="break-keep text-pretty text-sm text-foreground">{t('net.confirmBody')}</p>
          <p className="break-keep text-pretty text-xs text-muted-foreground">{t('net.confirmScope')}</p>
        </div>
      ) : net === 'ask' ? (!(asking && line === 'answerOnPhone') ? null : // Yuna 4987: no «press [허용…]» where no button can come (no word from the computer · no paired phone)
        <p className="break-keep text-pretty text-xs text-muted-foreground" data-testid="agent-permission-net">{t('net.askLine')}</p>
      ) : r.summary === null ? null : ( // story #4590: no detail read → no summary box
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="break-all font-mono text-xs text-foreground">{r.summary}</p>
          {notes.length > 0 ? <p className="mt-0.5 text-[11px] text-muted-foreground">{notes.join(' · ')}</p> : null}
        </div>
      )}
      {r.workdir ? <p className="text-[11px] text-muted-foreground">{t('workdir', { path: r.workdir })}</p> : null}
      {net === 'ask' && r.host_unread && answer === null ? (
        <p className="break-keep text-pretty text-xs text-muted-foreground" data-testid="agent-permission-line">{t('net.hostUnread')}</p>
      ) : answersHere ? (
        <PhoneAnswerPlace tool={tool ?? ''} auth={auth} answer={answer} onAnswer={onAnswer} net={net} host={r.host ?? ''} hostUnread={r.host_unread === true} />
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="agent-permission-line">
          {line === 'expired' ? t('line.expired')
            : line === 'unknown' ? t('line.unknown')
              : line === 'terminalOnly' ? t('line.terminalOnly')
                : line === 'noPairedPhone' ? t('line.noPairedPhone')
                  : t('line.answerOnPhone')}
        </p>
      )}
    </Card>
  );
}

/** The button place inside the phone app (명세 «폰 서명 · 권한 창 문구» ③ · B-2 결과 줄). */
function PhoneAnswerPlace({ tool, auth, answer, onAnswer, net = null, host = '', hostUnread = false }: {
  tool: string; auth: PhoneAuth | null; answer: Answer | null; onAnswer: (decision: 'allow' | 'deny') => void;
  /** story #4580 AC2: the network question's stage (its own buttons and result lines) */
  net?: 'ask' | 'confirm' | null; host?: string;
  /** story #4580 AC2 F2 (Yuna 2-7): the host could not be read — the request ended with nothing allowed */
  hostUnread?: boolean;
}) {
  const t = useTranslations('agentPermissions');
  const flat = useFlatHref();
  const a = answer;
  const pressed = a !== null; // a result after a press takes the focus the buttons had
  const buttons = net === 'confirm' ? (
    // Yuna «4580 AC2» ②: the opening one filled · «허용하지 않기» outline and focused first (the person picks the opening side)
    <div className="flex gap-2" data-testid="agent-permission-buttons">
      <Button size="sm" onClick={() => onAnswer('allow')}>{t('net.allowAndGo')}</Button>
      <Button size="sm" variant="outline" autoFocus onClick={() => onAnswer('deny')}>{t('net.dontAllow')}</Button>
    </div>
  ) : (
    <div className="flex gap-2" data-testid="agent-permission-buttons">
      {/* the person's one judgement here: both the same weight, as the desktop band (Yuna 4951 · no default pushed) */}
      <Button size="sm" variant="outline" onClick={() => onAnswer('allow')}>{net === 'ask' ? t('net.allowMore') : t('phone.allow')}</Button>
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
    case 'answered':
      if (net === 'ask' && a.decision === 'allow') return <Line focus>{hostUnread ? t('net.hostUnread') : t('net.checking')}</Line>; // the second card comes with the host
      if (net === 'confirm') return <Line focus>{a.decision === 'allow' ? t('net.allowedGo', { host }) : t('net.notAllowed')}</Line>;
      return <Line focus>{a.decision === 'allow' ? t('phone.allowed', { tool }) : t('phone.denied', { tool })}</Line>;
    case 'answered_by':
      return <Line focus>{a.name && a.decision ? t(a.decision === 'allow' ? 'phone.allowedBy' : 'phone.deniedBy', { name: a.name }) : t('phone.answeredElsewhere')}</Line>;
    case 'closed': return <Line focus>{t('phone.closed')}</Line>;
    case 'expired': return <Line focus>{t('line.expired')}</Line>;
    case 'unreachable': return <Line focus>{t('line.unknown')}</Line>;
    case 'not_paired': return <Line focus>{t('phone.notPaired')}</Line>;
    case 'biometric_required': return <><Line focus>{t('phone.biometricRequired')}</Line>{settings}</>;
    case 'no_screen_lock': return <><Line focus>{t('phone.noScreenLock')}</Line>{settings}</>;
    case 'key_invalidated':
    case 'not_registered':
      return (
        <>
          <Line focus>{a.kind === 'key_invalidated' ? t('phone.keyInvalidated') : t('phone.notRegistered')}</Line>
          <div><Button size="sm" variant="outline" asChild><a href={flat('/desktop/pair')}>{t('phone.pairAgain')}</a></Button></div>
        </>
      );
    // Kadir · PO 09:31Z ②: signed out — one button to sign in again; back here, the request still waits with its buttons
    case 'signed_out':
      return (
        <>
          <Line focus>{t('phone.signedOut')}</Line>
          <div><Button size="sm" variant="outline" asChild><a href={buildLoginRedirect(window.location.pathname + window.location.search)}>{t('phone.signInAgain')}</a></Button></div>
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
    <p ref={ref} tabIndex={-1} role="status" className="break-keep text-pretty text-xs text-muted-foreground outline-none" data-testid="agent-permission-phone-line">
      {children}
    </p>
  );
}
