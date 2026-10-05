'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Check, Circle, CircleDashed, CircleDot, Loader2, SquareX, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useFieldDraft } from '@/hooks/use-field-draft';
import { isPhoneApp, phoneCall } from '@/lib/phone-bridge';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';
import { checkCommand, commandOnPhone, type CommandDeps, type CommandOutcome, type Pending } from '@/lib/phone-command';
import { limitLine, limitTime, type SessionLimit } from '@/lib/agent-session-limit';

/**
 * story #4534 (명세 모음 B-3 · «상태 칩 ↔ 서버 세션 상태») — the agent's session in its DM: the desktop bar's words and shapes
 * (no new word). In a browser the web only looks (it has no device key to sign with): one line where the phone's buttons would be.
 * Inside the phone app, while the agent works: [멈춤] [지금 지시] — the shell signs (its own sheet · the OS prompt) and the strip
 * keeps one line for how it went. Read again on `desktop.session_changed` and every 30 s.
 */
// story #4534 (relay contract v1.12 · Yuna 03:04Z · 03:06Z): the board's own words — asked in the terminal · an error · paused at a
// usage limit — never shown as «다음 일 기다림»; a usage limit carries its why (`limit`)
type SessionState = 'starting' | 'working' | 'idle' | 'waiting_permission' | 'waiting_input' | 'error' | 'paused_limit' | 'stopped' | 'unknown';
interface View {
  device_name: string | null;
  // story #4534 (Kadir 4960 · PO 05:36Z): `state` = the five words a reader from before knows · `activity` = the board's own word
  state: SessionState | null;
  activity?: string | null;
  limit?: SessionLimit | null;
  remote_control: boolean;
  can_command?: boolean;
  pending_permission_request_id: string | null;
}

// the desktop bar's own marks and tones (board.ts DISPLAY · Yuna 17:27Z): idle = a filled dot, muted · done = a check, success ·
// working = primary · waiting for permission = warning · unknown = a dashed ring, muted
const SHAPES: Record<SessionState, { icon: LucideIcon; tone: string }> = {
  starting: { icon: Circle, tone: 'text-muted-foreground' },
  working: { icon: Loader2, tone: 'text-primary' },
  idle: { icon: Circle, tone: 'text-muted-foreground fill-current' },
  waiting_permission: { icon: AlertTriangle, tone: 'text-warning' },
  waiting_input: { icon: CircleDot, tone: 'text-foreground' },
  error: { icon: SquareX, tone: 'text-destructive' },
  paused_limit: { icon: Circle, tone: 'text-muted-foreground fill-current' },
  stopped: { icon: Check, tone: 'text-success' },
  unknown: { icon: CircleDashed, tone: 'text-muted-foreground' },
};
const REREAD_MS = 30_000;

/** story #4534 (Kadir 4960 · PO 05:36Z): the board's own word when the server sends one (`activity`), else the five-word `state`;
 *  a word this page does not know falls back to the five-word `state` (then «상태 모름») — never a crash (a server newer than this bundle) */
function shownState(view: View): SessionState {
  const known = (w: string | null | undefined): w is SessionState => !!w && Object.hasOwn(SHAPES, w);
  if (known(view.activity)) return view.activity;
  return known(view.state) ? view.state : 'unknown';
}
/** the daemon's cut (contracts/send-prompt-vectors.json text_max · UTF-16 units — a string's length) */
const INSTRUCTION_MAX = 8000;

const noSubscribe = () => () => {};
const notOnServer = () => false;

async function readView(agentId: string): Promise<View | null> {
  try {
    const res = await fetchWithAuth(`/api/agents/${agentId}/desktop-session`);
    return res.ok ? ((await res.json()) as View) : null;
  } catch {
    return null;
  }
}

export function AgentSessionStrip({ agentId, conversationId }: { agentId: string; conversationId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [nudges, setNudges] = useState(0);
  // story #4534: when the view was read — a limit's «passed» is judged on this page's clock at that read (never in render)
  const [readAt, setReadAt] = useState(0);

  useSseNotifications({
    extraEventNames: ['desktop.session_changed'],
    onExtraEvent: (_name, data) => {
      const raw = typeof data === 'string' ? data : JSON.stringify(data);
      try {
        if ((JSON.parse(raw) as { agent_member_id?: string }).agent_member_id === agentId) setNudges((n) => n + 1);
      } catch {
        // not ours
      }
    },
  });

  useEffect(() => {
    let off = false;
    const read = () => void readView(agentId).then((v) => { if (!off) { setView((prev) => v ?? prev); setReadAt(Date.now()); } });
    read();
    const id = setInterval(read, REREAD_MS);
    return () => { off = true; clearInterval(id); };
  }, [agentId, nudges]);

  if (!view?.state) return null; // not on a computer · no session: the DM as it was
  return <Strip view={{ ...view, state: shownState(view) }} readAt={readAt} agentId={agentId} conversationId={conversationId} reread={() => setNudges((n) => n + 1)} />;
}

/** what the strip's line says after a press: on its way, or how it ended (stop · instruction keep their own verbs — Yuna 12:47Z) */
type Result = { verb: 'stop' | 'send'; busy: true } | { verb: 'stop' | 'send'; busy: false; outcome: CommandOutcome };

function Strip({ view, readAt, agentId, conversationId, reread }: { view: View & { state: SessionState }; readAt: number; agentId: string; conversationId: string; reread: () => void }) {
  const t = useTranslations('chats.agentSession');
  const flatHref = useFlatHref();
  const phone = useSyncExternalStore(noSubscribe, isPhoneApp, notOnServer);
  const [result, setResult] = useState<Result | null>(null);
  // Kadir 4955 · Yuna · PO 13:27Z: a command whose end is not known — [결과 확인] follows it (never a second one). While it is
  // unknown: an instruction → [지금 지시] becomes [결과 확인] ([멈춤] stays — the safety handle) · a stop → both become [결과 확인]
  const [pending, setPending] = useState<Pending | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // what was written stays until it went somewhere (spec B-3: «쓴 글은 남김») — kept as a draft per agent · conversation (#4370)
  const [draft, setDraft, clearDraft] = useFieldDraft({ surface: 'agent-instruct', targetId: `${agentId}:${conversationId}`, field: 'text' });
  // Claude at a usage limit (it may continue by itself, or ask in its terminal) wears the board's «사용 한도» look (Yuna 08:46Z)
  const claudeLimit = view.state === 'waiting_input' && !!view.limit?.self_resume;
  const { icon: Shape, tone } = claudeLimit ? { icon: AlertTriangle, tone: 'text-warning' } : SHAPES[view.state];
  const unknown = view.state === 'unknown';
  const busy = result?.busy === true;
  // the buttons: inside the phone app · while it works · remote control on · a person who may command it (the server's own rule)
  const canAct = phone && view.state === 'working' && view.remote_control && view.can_command !== false;
  const checkOnly = pending?.verb === 'stop';
  const label = claudeLimit ? t('state.usage_limit')
    : view.state === 'starting' ? t('state.starting')
      : view.state === 'working' ? t('state.working')
        : view.state === 'idle' ? t('state.idle')
          : view.state === 'waiting_permission' ? t('state.waiting_permission')
            : view.state === 'waiting_input' ? t('state.waiting_input')
              : view.state === 'error' ? t('state.error')
                : view.state === 'paused_limit' ? t('state.paused_limit')
                  : view.state === 'stopped' ? t('state.stopped') : t('state.unknown');

  const deps: CommandDeps = {
    phoneCall,
    newKey: () => crypto.randomUUID(),
    sendMessage: async (content) => {
      try {
        const res = await fetchWithAuth(`/api/conversations/${conversationId}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
  const settle = (verb: 'stop' | 'send', outcome: CommandOutcome) => {
    if (verb === 'send' && (outcome.kind === 'sent_now' || outcome.kind === 'sent_after_step' || outcome.kind === 'sent_as_message')) clearDraft();
    setPending(outcome.kind === 'unknown' ? outcome.pending : null);
    setResult({ verb, busy: false, outcome });
    reread();
  };
  const run = async (verb: 'stop' | 'send', text?: string) => {
    setResult({ verb, busy: true });
    settle(verb, await commandOnPhone(
      verb === 'stop' ? { agentId, kind: 'stop_session' } : { agentId, kind: 'send_prompt', text: text ?? '', conversationId }, deps,
    ));
  };
  // [결과 확인]: the same command followed again — no signature, no sheet
  const check = async () => {
    if (!pending) return;
    setResult({ verb: pending.verb, busy: true });
    settle(pending.verb, await checkCommand(agentId, pending, deps));
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2 text-xs" data-testid="agent-session-strip">
      <span
        className={unknown ? 'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground'
          : 'inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-foreground'}
        data-testid="agent-session-chip"
      >
        <Shape className={`${view.state === 'idle' || view.state === 'paused_limit' ? 'size-2' : 'size-3'} ${tone}${view.state === 'working' ? ' animate-spin' : ''}`} aria-hidden />
        {label}
      </span>
      {view.device_name ? <span className="text-muted-foreground">{view.device_name}</span> : null}
      {canAct ? (
        <span className="ml-auto flex gap-2" data-testid="agent-session-buttons">
          {checkOnly ? null : <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('stop')}>{t('button.stop')}</Button>}
          {pending
            ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>{t('button.checkResult')}</Button>
            : <Button size="sm" variant="outline" disabled={busy} onClick={() => setSheetOpen(true)}>{t('button.instruct')}</Button>}
        </span>
      ) : null}
      {result ? <ResultLine result={result} /> : <Line view={view} now={readAt} phone={phone} href={flatHref('/inbox?tab=gates')} />}
      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sheet.title')}</DialogTitle>
            <DialogDescription className="break-keep">{t('sheet.note')}</DialogDescription>
          </DialogHeader>
          <textarea
            aria-label={t('sheet.title')}
            className="min-h-24 w-full rounded-md border border-border bg-background p-2 text-base"
            value={draft}
            maxLength={INSTRUCTION_MAX}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="agent-instruct-text"
          />
          <DialogFooter>
            <Button
              disabled={!draft.trim() || busy}
              onClick={() => { const text = draft; setSheetOpen(false); void run('send', text); }}
            >
              {t('sheet.send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResultLine({ result }: { result: Result }) {
  const t = useTranslations('chats.agentSession');
  const flatHref = useFlatHref();
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.focus(); }, [result]); // the line takes focus (Yuna 12:47Z C)
  const line = (text: string, action?: ReactNode) => (
    <div className="flex w-full flex-wrap items-center gap-2">
      <p ref={ref} tabIndex={-1} className="break-keep text-muted-foreground outline-none" role="status" data-testid="agent-command-line">{text}</p>
      {action}
    </div>
  );
  const stop = result.verb === 'stop';
  if (result.busy) return line(stop ? t('command.stopping') : t('command.sending'));
  const signIn = <Button size="sm" variant="outline" asChild><a href={buildLoginRedirect(window.location.pathname + window.location.search)}>{t('command.signInAgain')}</a></Button>;
  const pairAgain = <Button size="sm" variant="outline" asChild><a href={flatHref('/desktop/pair')}>{t('command.pairAgain')}</a></Button>;
  const settings = <Button size="sm" variant="outline" onClick={() => void phoneCall('app.settings')}>{t('command.openSettings')}</Button>;
  switch (result.outcome.kind) {
    case 'stopped': return line(t('command.stopped'));
    case 'already_stopped': return line(t('command.alreadyStopped'));
    case 'sent_now': return line(t('command.sentNow'));
    case 'sent_after_step': return line(t('command.sentAfterStep'));
    case 'sent_as_message': return line(t('command.sentAsMessage'));
    case 'unreachable': return line(stop ? t('command.stopUnreachable') : t('command.sendUnreachable'));
    case 'unknown': return line(stop ? t('command.stopUnknown') : t('command.sendUnknown'));
    case 'remote_off': return line(t('line.remoteOff'));
    case 'conversation_not_found': return line(t('command.conversationNotFound'));
    case 'cancelled': return line(stop ? t('command.stop.cancelled') : t('command.send.cancelled'));
    case 'not_paired': return line(stop ? t('command.stop.notPaired') : t('command.send.notPaired'));
    case 'signed_out': return line(stop ? t('command.stop.signedOut') : t('command.send.signedOut'), signIn);
    case 'key_invalidated': return line(stop ? t('command.stop.keyInvalidated') : t('command.send.keyInvalidated'), pairAgain);
    case 'not_registered': return line(stop ? t('command.stop.notRegistered') : t('command.send.notRegistered'), pairAgain);
    case 'biometric_required': return line(stop ? t('command.stop.biometricRequired') : t('command.send.biometricRequired'), settings);
    case 'no_screen_lock': return line(stop ? t('command.stop.noScreenLock') : t('command.send.noScreenLock'), settings);
    default: return line(stop ? t('command.stop.failed') : t('command.send.failed'));
  }
}

function Line({ view, now, phone, href }: { view: View & { state: SessionState }; now: number; phone: boolean; href: string }) {
  const t = useTranslations('chats.agentSession');
  const locale = useLocale();
  if (view.state === 'unknown') return <p className="w-full text-muted-foreground" data-testid="agent-session-line">{t('line.unknown')}</p>;
  // story #4534 (Yuna 03:04Z): what to do is «on that computer» — its own line whatever remote control says; no buttons; whether a
  // time has passed is this page's clock
  const rest = limitLine(view.state, view.limit ?? null, now);
  if (rest) {
    const time = rest.at ? limitTime(rest.at, now, locale) : '';
    const words = {
      waitingInput: () => t('line.waitingInput'), error: () => t('line.error'),
      paused: () => t('line.paused', { time }), pausedAgain: () => t('line.pausedAgain', { time }),
      limitMaybe: () => t('line.limitMaybe'), limitNo: () => t('line.limitNo'), limitUnknown: () => t('line.limitUnknown'),
      limitErrorNoTime: () => t('line.limitErrorNoTime'), limitErrorAhead: () => t('line.limitErrorAhead', { time }), limitErrorPassed: () => t('line.limitErrorPassed'),
    }[rest.key];
    return <p className="w-full break-keep text-muted-foreground" data-testid="agent-session-line">{words()}</p>;
  }
  if (view.state !== 'working' && view.state !== 'waiting_permission') return null; // idle · starting · stopped: no button place
  // remote control off wins over both (Yuna 17:27Z ②)
  if (!view.remote_control) return <p className="w-full text-muted-foreground" data-testid="agent-session-line">{t('line.remoteOff')}</p>;
  if (view.state === 'waiting_permission') {
    // the web's inbox card only looks, so not «answer there» — where the request is (Yuna 17:27Z ②); the phone app's card answers
    return <Link className="w-full text-muted-foreground underline" href={href} data-testid="agent-session-line">{phone ? t('line.inboxPhone') : t('line.inbox')}</Link>;
  }
  // inside the phone app the buttons stand in the line's place
  return phone ? null : <p className="w-full text-muted-foreground" data-testid="agent-session-line">{t('line.onPhone')}</p>;
}
