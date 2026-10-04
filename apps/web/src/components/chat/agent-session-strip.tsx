'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Circle, CircleDashed, Loader2, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useFieldDraft } from '@/hooks/use-field-draft';
import { isPhoneApp, phoneCall } from '@/lib/phone-bridge';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';
import { commandOnPhone, type CommandOutcome } from '@/lib/phone-command';

/**
 * story #4534 (명세 모음 B-3 · «상태 칩 ↔ 서버 세션 상태») — the agent's session in its DM: the desktop bar's words and shapes
 * (no new word). In a browser the web only looks (it has no device key to sign with): one line where the phone's buttons would be.
 * Inside the phone app, while the agent works: [멈춤] [지금 지시] — the shell signs (its own sheet · the OS prompt) and the strip
 * keeps one line for how it went. Read again on `desktop.session_changed` and every 30 s.
 */
type SessionState = 'starting' | 'working' | 'idle' | 'waiting_permission' | 'stopped' | 'unknown';
interface View {
  device_name: string | null;
  state: SessionState | null;
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
  stopped: { icon: Check, tone: 'text-success' },
  unknown: { icon: CircleDashed, tone: 'text-muted-foreground' },
};
const REREAD_MS = 30_000;
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
    const read = () => void readView(agentId).then((v) => { if (!off) setView((prev) => v ?? prev); });
    read();
    const id = setInterval(read, REREAD_MS);
    return () => { off = true; clearInterval(id); };
  }, [agentId, nudges]);

  if (!view?.state) return null; // not on a computer · no session: the DM as it was
  return <Strip view={view as View & { state: SessionState }} agentId={agentId} conversationId={conversationId} reread={() => setNudges((n) => n + 1)} />;
}

/** what the strip's line says after a press: on its way, or how it ended (stop · instruction keep their own verbs — Yuna 12:47Z) */
type Result = { verb: 'stop' | 'send'; busy: true } | { verb: 'stop' | 'send'; busy: false; outcome: CommandOutcome };

function Strip({ view, agentId, conversationId, reread }: { view: View & { state: SessionState }; agentId: string; conversationId: string; reread: () => void }) {
  const t = useTranslations('chats.agentSession');
  const flatHref = useFlatHref();
  const phone = useSyncExternalStore(noSubscribe, isPhoneApp, notOnServer);
  const [result, setResult] = useState<Result | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // what was written stays until it went somewhere (spec B-3: «쓴 글은 남김») — kept as a draft per agent · conversation (#4370)
  const [draft, setDraft, clearDraft] = useFieldDraft({ surface: 'agent-instruct', targetId: `${agentId}:${conversationId}`, field: 'text' });
  const { icon: Shape, tone } = SHAPES[view.state];
  const unknown = view.state === 'unknown';
  const busy = result?.busy === true;
  // the buttons: inside the phone app · while it works · remote control on · a person who may command it (the server's own rule)
  const canAct = phone && view.state === 'working' && view.remote_control && view.can_command !== false;
  const label = view.state === 'starting' ? t('state.starting')
    : view.state === 'working' ? t('state.working')
      : view.state === 'idle' ? t('state.idle')
        : view.state === 'waiting_permission' ? t('state.waiting_permission')
          : view.state === 'stopped' ? t('state.stopped') : t('state.unknown');

  const run = async (verb: 'stop' | 'send', text?: string) => {
    setResult({ verb, busy: true });
    const outcome = await commandOnPhone(
      verb === 'stop' ? { agentId, kind: 'stop_session' } : { agentId, kind: 'send_prompt', text: text ?? '', conversationId },
      {
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
      },
    );
    if (verb === 'send' && (outcome.kind === 'sent_now' || outcome.kind === 'sent_after_step' || outcome.kind === 'sent_as_message')) clearDraft();
    setResult({ verb, busy: false, outcome });
    reread();
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2 text-xs" data-testid="agent-session-strip">
      <span
        className={unknown ? 'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground'
          : 'inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-foreground'}
        data-testid="agent-session-chip"
      >
        <Shape className={`${view.state === 'idle' ? 'size-2' : 'size-3'} ${tone}${view.state === 'working' ? ' animate-spin' : ''}`} aria-hidden />
        {label}
      </span>
      {view.device_name ? <span className="text-muted-foreground">{view.device_name}</span> : null}
      {canAct ? (
        <span className="ml-auto flex gap-2" data-testid="agent-session-buttons">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('stop')}>{t('button.stop')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setSheetOpen(true)}>{t('button.instruct')}</Button>
        </span>
      ) : null}
      {result ? <ResultLine result={result} /> : <Line view={view} phone={phone} href={flatHref('/inbox?tab=gates')} />}
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

function Line({ view, phone, href }: { view: View & { state: SessionState }; phone: boolean; href: string }) {
  const t = useTranslations('chats.agentSession');
  if (view.state === 'unknown') return <p className="w-full text-muted-foreground" data-testid="agent-session-line">{t('line.unknown')}</p>;
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
