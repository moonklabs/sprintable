'use client';

// story #4714 (UX-1 · onboarding · phone · copy yuna/4714-copy-1017.md · contract 02d2cf71 §14): the onboarding's one screen for someone who
// came from the PHONE APP. The first screen's «지금은 Mac 앱만 있어요» (a browser that is not a Mac) says the opposite of what is true here — a
// phone pairs with a Mac and starts its agents from it — so inside the phone app this screen takes its place (AC1).
//   · remote control off → the owner turns it on right here (one button), anyone else is told who can;
//   · no computer paired (AC2) → «에이전트는 Mac에서 돌아가요» + [Mac에서 열 링크를 메일로 받기] (the server mails the signed-in person's OWN address a plain link;
//     drawn only where the Mac app is offered) + the pairing link;
//   · a computer paired, no agent on it → one line, no button;
//   · a computer paired with agents (AC3) → pick the agent and the project (names only · «새 폴더는 Mac 앞에서») → [시작] → the shell signs →
//     the computer starts the session from its own folder; every end is one line.
// Nothing here knows a path: the computer resolves the folder from its own files.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { useOrgRemoteControl, putOrgRemoteControl } from '@/lib/org-remote-control';
import { usePairHref } from '@/hooks/use-pair-href';
import { sendMacLinkMail, type MacLinkMailOutcome } from '@/lib/phone-mac-link-mail';
import { Loader2 } from 'lucide-react';
import { firstInstructionHref } from '@/lib/onboarding/first-instruction';
import { beginFlow, checkStart, endFlow, groupByComputer, isLeaving, readStartable, startOnPhone, waitForSession, type Flow, type Pending, type StartOutcome, type StartableAgent, type StartableComputer, type StartableRead, type StartableView } from '@/lib/phone-start';

type Read = { kind: 'reading' } | { kind: 'failed' } | { kind: 'no_phone' } | { kind: 'view'; view: StartableView };

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

/** true while the component is mounted — an answer that comes after it left sets nothing */
function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

/** `macDownloadEnabled`: the server's own judgement that the Mac app is offered here (`isDesktopDownloadEnabled`, resolved by the page) — false/absent: no mail button, no line */
export function PhoneFirstScreen({ orgId, chatsHref, macDownloadEnabled = false, returnHref }: { orgId: string | null; chatsHref?: string; macDownloadEnabled?: boolean; returnHref?: string }) {
  const t = useTranslations('onboarding.phone');
  const { phoneCall } = usePhoneBridge();
  const pairHref = usePairHref(returnHref); // story 4780: [Close] of the pairing screen comes back to this start screen — or to `returnHref` (the sign-up screen: Today, where the checklist goes on)
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  // the answer lands in a promise callback (never synchronously in the effect); a phone with no screen lock can pair with nothing — the pairing
  // page says why, here it is the «no Mac yet» screen
  const land = useCallback((r: StartableRead) => {
    setRead(r.kind === 'view' ? { kind: 'view', view: r.view } : r.kind === 'no_phone' || r.kind === 'no_screen_lock' ? { kind: 'no_phone' } : { kind: 'failed' });
  }, []);
  // one read at a time counts, and a read is a flow: a newer read · the end of the screen · a way out STOP the older one — a stopped read asks for nothing more and draws nothing
  const readFlow = useRef<Flow | null>(null);
  const stopRead = useCallback(() => { if (readFlow.current) { readFlow.current.stopped = true; endFlow(readFlow.current); } }, []);
  const readNow = useCallback(() => {
    stopRead(); // a newer read STOPS the older one (a restored page reads again while an older read may still be out)
    const flow = beginFlow();
    readFlow.current = flow;
    void readStartable(phoneCall, () => flow.stopped).catch((): StartableRead => ({ kind: 'failed' })).then((r) => { endFlow(flow); if (!flow.stopped) land(r); });
  }, [phoneCall, land, stopRead]);
  const dropReads = stopRead; // leaving the page: whatever is still out is dropped
  useEffect(() => {
    readNow();
    return dropReads;
  }, [readNow, dropReads]);
  // restored from the back-forward cache: a read that was stopped by a way out left this screen «reading» — read again (lib/phone-start.ts has released the way-out window by then)
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { setRead({ kind: 'reading' }); readNow(); } };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [readNow]);
  const reload = () => { if (isLeaving()) return; setRead({ kind: 'reading' }); readNow(); }; // a press (retry · turned on · remote off found): the empty area, then read again — not on a page that is on its way out (it would blank the screen for a read that is refused)

  // reading: an empty area (the device is read after mount — no flash)
  if (read.kind === 'reading') return <div data-testid="onboarding-phone-reading" aria-busy="true" />;

  if (read.kind === 'failed') {
    return (
      <Card className="break-keep flex flex-col gap-3 p-6" data-testid="onboarding-phone-read-failed">
        <p role="alert" className="text-sm text-muted-foreground">{t('result.readFailed')}</p>
        <div><Button variant="outline" onClick={reload}>{t('result.retry')}</Button></div>
      </Card>
    );
  }

  // remote control off comes first: pairing itself is refused while it is off, so «pair» would be a dead end (branch 1 before branch 2)
  if (read.kind === 'view' && !read.view.remote_control) return <RemoteOff orgId={orgId} onTurnedOn={reload} />;
  if (read.kind === 'no_phone' || read.view.computers.length === 0) return <NoMac pairHref={pairHref} mailEnabled={macDownloadEnabled} />;

  return <Computers computers={groupByComputer(read.view.computers)} chatsHref={chatsHref} onRemoteOff={reload} />; // story 4734: one computer, its setups' agents together
}

// only an agent the person may command can be started from here (`can_command`) — the others are not offered
const commandable = (c: StartableComputer) => c.agents.filter((a) => a.can_command);

/** the computers this phone is paired with: the first one that can take a start (reachable first) is the one shown; with more than one such computer the person may choose (story 4714 · PO 10-19: never «one Mac» assumed) */
function Computers({ computers, chatsHref, onRemoteOff }: { computers: StartableComputer[]; chatsHref?: string; onRemoteOff: () => void }) {
  const t = useTranslations('onboarding.phone');
  const startable = computers.filter((c) => commandable(c).length > 0);
  // a computer none of whose agents has a project to start is no choice (a card with an empty list and a start that cannot be pressed); if none has one the card says so as before
  const offered = startable.filter((c) => commandable(c).some((a) => a.projects.length > 0));
  const choices = offered.length > 0 ? offered : startable;
  const [picked, setPicked] = useState<string | null>(null);
  const computer = choices.find((c) => c.setup_id === picked) ?? choices.find((c) => c.reachable) ?? choices[0] ?? computers[0];
  if (commandable(computer).length === 0) {
    return (
      <Card className="break-keep p-6" data-testid="onboarding-phone-no-agent">
        {/* Yuna 4714 §5: the first-agent line is true only when the computer has no agent at all; agents it has but the person may not start get their own line */}
        <p className="text-sm text-foreground">{computer.agents.length === 0 ? (computer.agents_hidden === 'message_policy' ? t('noAgent.lineNoTalk', { device: computer.device_name }) : t('noAgent.line', { device: computer.device_name })) : t('noAgent.lineNoAccess', { device: computer.device_name })}</p>
      </Card>
    );
  }
  // keyed by the computer: another computer is another screen — the agent · project picks and any result line of the first are not carried over
  return (
    <StartCard key={computer.setup_id} computer={computer} agents={commandable(computer)} chatHref={chatsHref} onRemoteOff={onRemoteOff}
      computers={choices.length > 1 ? choices : null} onPickComputer={setPicked} />
  );
}

type MailState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'limited' } | { kind: 'need_verify' } | { kind: 'failed' } | { kind: 'hidden' };

function NoMac({ pairHref, mailEnabled }: { pairHref: string; mailEnabled: boolean }) {
  const t = useTranslations('onboarding.phone');
  const alive = useAlive();
  const [mail, setMail] = useState<MailState>({ kind: 'idle' });
  const sending = mail.kind === 'sending';
  const out = useRef(false); // a call is out: two taps in one tick both read the same render's state, so the guard is a ref (one mail per press)
  const requestMail = async () => {
    if (out.current) return;
    out.current = true;
    setMail({ kind: 'sending' });
    let o: MacLinkMailOutcome;
    try { o = await sendMacLinkMail(); } catch { o = { kind: 'failed' }; }
    out.current = false;
    if (!alive.current) return; // the screen is gone — nothing is set
    // the server's word is the only one: «sent» only for a delivered mail; the Mac app not offered here (409) draws nothing at all
    setMail(o.kind === 'not_enabled' ? { kind: 'hidden' } : o);
  };
  const showMail = mailEnabled && mail.kind !== 'hidden';
  return (
    <div className="space-y-4" data-testid="onboarding-phone-no-mac">
      <div className="text-center">
        <h1 id="onboarding-step-title" className="break-keep text-2xl font-bold text-foreground">{t('noMac.title')}</h1>
        <p className="mt-2 break-keep text-sm text-muted-foreground">{t('noMac.body')}</p>
      </div>
      {showMail ? (
        <div className="space-y-2 text-center" data-testid="onboarding-phone-mail">
          {/* one state at a time under the button's place: button → sending → sent (+ again) | limited | need-verify | failed (the button is back) */}
          {mail.kind === 'sent' ? (
            <p role="status" className="break-keep text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="onboarding-phone-mail-sent">
              {t('noMac.mailSent', { email: mail.email })}{' '}
              <Button variant="link" size="sm" onClick={requestMail} className="h-auto whitespace-normal px-0 py-0 text-sm" data-testid="onboarding-phone-mail-again">{t('noMac.mailAgain')}</Button>
            </p>
          ) : mail.kind === 'need_verify' ? (
            <p role="status" className="break-keep text-sm text-muted-foreground" data-testid="onboarding-phone-mail-need-verify">{t('noMac.mailNeedVerify')}</p>
          ) : (
            <>
              <Button variant="link" size="sm" onClick={requestMail} disabled={sending} className="h-auto whitespace-normal px-0 py-0 text-sm" data-testid="onboarding-phone-mail-button">
                {sending ? t('noMac.mailSending') : t('noMac.mail')}
              </Button>
              {mail.kind === 'limited' ? <p role="status" className="break-keep text-sm text-muted-foreground" data-testid="onboarding-phone-mail-limited">{t('noMac.mailLimited')}</p> : null}
              {mail.kind === 'failed' ? <p role="alert" className="break-keep text-sm text-destructive" data-testid="onboarding-phone-mail-failed">{t('noMac.mailFailed')}</p> : null}
            </>
          )}
        </div>
      ) : null}
      {/* the pairing page is the existing one (the shell has the camera and the key); a text link, drawn in every state */}
      <p className="text-center">
        <Button variant="link" size="sm" asChild className="h-auto whitespace-normal px-0 py-0 text-sm"><a href={pairHref} data-testid="onboarding-phone-pair">{t('noMac.pair')}</a></Button>
      </p>
    </div>
  );
}

function RemoteOff({ orgId, onTurnedOn }: { orgId: string | null; onTurnedOn: () => void }) {
  const t = useTranslations('onboarding.phone');
  const alive = useAlive();
  const [rc, setRc, readFailed] = useOrgRemoteControl(orgId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const canChange = rc?.can_change === true; // only the person who can switch it gets the button (the same test as the web's switch)
  const turnOn = async () => {
    if (!orgId || busy) return;
    setBusy(true); setFailed(false);
    const r = await putOrgRemoteControl(orgId);
    if (!alive.current) return; // the screen is gone — nothing is set, nothing moves on
    setBusy(false);
    if (!r.ok) { setFailed(true); return; }
    if (r.data) setRc(r.data);
    onTurnedOn(); // the screen moves to the next one with no confirmation line
  };
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="onboarding-phone-off">
      <h1 id="onboarding-step-title" className="text-lg font-semibold text-foreground">{t('off.title')}</h1>
      {rc === null ? (
        // who may turn it on is not known yet (still reading → nothing drawn) or could not be read (a line and one retry — never a dead end)
        readFailed ? (
          <div className="space-y-2" data-testid="onboarding-phone-off-read-failed">
            <p role="alert" className="text-sm text-muted-foreground">{t('result.readFailed')}</p>
            <div><Button variant="outline" onClick={onTurnedOn}>{t('result.retry')}</Button></div>
          </div>
        ) : null
      ) : (
        <p className="text-sm text-muted-foreground">{canChange ? t('off.bodyOwner') : t('off.bodyOther')}</p>
      )}
      {canChange ? (
        <div className="space-y-1">
          <Button size="lg" className="w-full whitespace-nowrap" disabled={busy} onClick={() => void turnOn()} data-testid="onboarding-phone-turn-on">{t('off.action')}</Button>
          {failed ? <p role="alert" className="text-xs text-destructive">{t('off.failed')}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

function StartCard({ computer, agents, chatHref, onRemoteOff, computers, onPickComputer }: { computer: StartableComputer; agents: StartableAgent[]; chatHref?: string; onRemoteOff: () => void; computers: StartableComputer[] | null; onPickComputer: (setupId: string) => void }) {
  const t = useTranslations('onboarding.phone');
  const { phoneCall } = usePhoneBridge();
  const [agentId, setAgentId] = useState<string | null>(agents.length === 1 ? agents[0].agent_member_id : null); // one agent → picked already
  const agent: StartableAgent | undefined = agents.find((a) => a.agent_member_id === agentId);
  const [projectId, setProjectId] = useState<string | null>(null);
  const projects = agent?.projects ?? [];
  const project = projects.find((p) => p.project_id === projectId);
  const [sheet, setSheet] = useState<'computer' | 'agent' | 'project' | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<StartOutcome | null>(null);
  const [waitedOut, setWaitedOut] = useState(false); // started on the Mac, but the session did not stand within the limit
  const [standing, setStanding] = useState(false); // started on the Mac, waiting for the server to say the agent runs (the spinner shows only now)
  // a start whose end is not known: the only way on is [결과 확인] (the same command) — a new press would sign again and could start it twice
  const locked = outcome?.kind === 'unknown';
  const frozen = busy || locked; // a start is in flight, or its end is not known: nothing the person picks may change the pick (or clear what [결과 확인] follows)
  const pending = useRef<Pending | null>(null);
  const inFlight = useRef(false); // a press is out (a second click in the same tick sees the old `busy`: this ref is what stops a second signing)
  const startedIn = useRef<string | null>(null); // the project the press started in (the conversation opens in it)
  const alive = useAlive();
  const deps = { phoneCall, newKey };

  const apply = (o: StartOutcome) => {
    setOutcome(o);
    pending.current = o.kind === 'unknown' ? o.pending : null;
    if (o.kind === 'remote_off') onRemoteOff(); // the screen returns to «원격 제어가 꺼져 있어요»
    if (o.kind === 'list_changed') onRemoteOff(); // story 4714: the pick is gone from the list (the agent's message policy changed · it left): read the list again — the screen then says what is true (the policy line · the plain list), never «tap again» for a start that cannot work
  };
  // ONE stop signal per press (a `Flow`): the bridge call, the post, the command poll, the wait for the session to stand and the move all look at the same `stopped`.
  // A way out · the end of this screen stop it; what a stopped flow gets back later does nothing (no request · no drawing · no move).
  const flowRef = useRef<Flow | null>(null);
  useEffect(() => () => { if (flowRef.current) { flowRef.current.stopped = true; endFlow(flowRef.current); } }, []);
  // started ≠ stood (story 4714 AC3): «started» is the Mac's word that it spawned the session. The conversation opens when the SERVER says the agent runs on
  // that computer (the same `running` word the landing reads); until then the button stays «starting». Not within the limit: a line says so, the screen is free again.
  const settle = async (o: StartOutcome, flow: Flow) => {
    if (flow.stopped) { if (alive.current) { setBusy(false); setStanding(false); } return; } // stopped: draws nothing, moves nothing, asks for nothing — the screen is only freed
    apply(o);
    if (o.kind === 'started' && agent) {
      setStanding(true);
      const seen = await waitForSession({ setupId: agent.setup_id ?? computer.setup_id, agentId: agent.agent_member_id }, { ...deps, alive: () => !flow.stopped });
      setStanding(false);
      if (flow.stopped) { if (alive.current) setBusy(false); return; }
      if (seen === 'stood') { window.location.assign(firstInstructionHref(agent.agent_member_id, startedIn.current)); return; } // leaves the page: the screen stays busy until it does
      setWaitedOut(true);
    }
    setBusy(false);
  };
  const run = async (begin: () => Promise<StartOutcome>) => {
    inFlight.current = true;
    const flow = beginFlow();
    flowRef.current = flow;
    try {
      setBusy(true); setWaitedOut(false);
      const o = await begin().catch((): StartOutcome => ({ kind: 'failed' }));
      await settle(o, flow);
    } finally { endFlow(flow); inFlight.current = false; }
  };
  const start = async () => {
    if (busy || inFlight.current || isLeaving() || !agent || !project) return; // a page on its way out (a way-out press) starts nothing new
    setOutcome(null);
    startedIn.current = project.project_id;
    await run(() => startOnPhone({ setupId: agent.setup_id ?? computer.setup_id, agentId: agent.agent_member_id, projectId: project.project_id }, { ...deps, flow: flowRef.current ?? undefined }));
  };
  const check = async () => {
    if (busy || inFlight.current || isLeaving() || !pending.current) return;
    const p = pending.current;
    await run(() => checkStart(p, { ...deps, flow: flowRef.current ?? undefined }));
  };

  const reason = !agent ? t('start.needAgent') : !project ? t('start.needProject') : null;
  // the line under [시작] for an end that is a refusal (a started or cancelled start has none) — literal keys, one per end
  const resultLine = (kind: StartOutcome['kind']): string | null => {
    switch (kind) {
      case 'no_folder': return t('result.noFolder');
      case 'already_running': return t('result.alreadyRunning');
      case 'unreachable': return t('result.unreachable');
      case 'not_paired': return t('result.notPaired');
      case 'remote_off': return t('result.remoteOff');
      case 'no_screen_lock': return t('result.noScreenLock');
      case 'biometric_required': return t('result.biometricRequired');
      case 'key_invalidated': return t('result.keyInvalidated');
      case 'not_registered': return t('result.notRegistered');
      case 'signed_out': return t('result.signedOut');
      case 'unknown': return t('result.unknown');
      case 'failed': return t('result.failed');
      default: return null; // started · cancelled
    }
  };
  const line = outcome ? resultLine(outcome.kind) : null;
  return (
    <div className="space-y-4" data-testid="onboarding-phone-start">
      <h1 id="onboarding-step-title" className="break-keep text-center text-2xl font-bold text-foreground">{t('start.title', { device: computer.device_name })}</h1>
      <Card className="break-keep flex flex-col gap-3 p-4">
        {computers ? (
          <PickRow label={t('start.computerLabel')} value={computer.device_name} onOpen={() => setSheet('computer')} disabled={frozen} testId="onboarding-phone-computer" />
        ) : null}
        {agents.length > 1 ? (
          <PickRow label={t('start.agentLabel')} value={agent?.name ?? null} onOpen={() => setSheet('agent')} disabled={frozen} testId="onboarding-phone-agent" />
        ) : (
          <div className="flex min-h-11 flex-col justify-center" data-testid="onboarding-phone-agent-fixed">
            <span className="text-xs text-muted-foreground">{t('start.agentLabel')}</span>
            <span className="text-sm font-medium text-foreground">{agents[0].name}</span>
          </div>
        )}
        <PickRow label={t('start.projectLabel')} value={project?.name ?? null} onOpen={() => setSheet('project')} disabled={!agent || frozen} testId="onboarding-phone-project" />
        <p className="text-xs text-muted-foreground" data-testid="onboarding-phone-new-folder">{t('start.newFolder')}</p>
      </Card>
      <div className="space-y-1">
        <Button size="lg" className="w-full whitespace-nowrap" disabled={busy || locked || reason !== null} onClick={() => void start()} data-testid="onboarding-phone-start-go">
          {busy ? <>{standing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" data-testid="onboarding-phone-standing" /> : null}{t('start.starting')}</> : t('start.action')}
        </Button>
        {reason ? <p className="text-xs text-muted-foreground" data-testid="onboarding-phone-reason">{reason}</p> : null}
      </div>
      {outcome?.kind === 'started' && waitedOut ? (
        <div className="space-y-2" data-testid="onboarding-phone-connecting-box">
          <p role="status" className="break-keep text-sm text-muted-foreground" data-testid="onboarding-phone-connecting">{t('result.connecting')}</p>
          {agent ? <div><Button variant="outline" asChild><a href={firstInstructionHref(agent.agent_member_id, startedIn.current)} data-testid="onboarding-phone-open-started-chat">{t('result.openChat')}</a></Button></div> : null}
        </div>
      ) : null}
      {outcome && line ? (
        <div className="space-y-2" data-testid="onboarding-phone-result">
          <p role={outcome.kind === 'already_running' || outcome.kind === 'unknown' ? 'status' : 'alert'}
            className={`text-sm ${outcome.kind === 'already_running' || outcome.kind === 'unknown' ? 'text-muted-foreground' : 'text-destructive'}`}>
            {line}
          </p>
          {outcome.kind === 'already_running' && chatHref ? <div><Button variant="outline" asChild><a href={chatHref} data-testid="onboarding-phone-open-chat">{t('result.openChat')}</a></Button></div> : null}
          {outcome.kind === 'unknown' ? <div><Button variant="outline" disabled={busy} onClick={() => void check()} data-testid="onboarding-phone-check">{t('result.check')}</Button></div> : null}
        </div>
      ) : null}
      {sheet ? (
        <PickSheet
          title={sheet === 'computer' ? t('start.computerSheetTitle') : sheet === 'agent' ? t('start.agentLabel') : t('start.projectSheetTitle')}
          rows={sheet === 'computer' ? (computers ?? []).map((c) => ({ id: c.setup_id, name: c.device_name })) : sheet === 'agent' ? agents.map((a) => ({ id: a.agent_member_id, name: a.name })) : projects.map((p) => ({ id: p.project_id, name: p.name }))}
          selected={sheet === 'computer' ? computer.setup_id : sheet === 'agent' ? agentId : projectId}
          onPick={(id) => {
            if (frozen) { setSheet(null); return; }
            if (sheet === 'computer') { setSheet(null); if (id !== computer.setup_id) onPickComputer(id); return; } // the screen is rebuilt for the other computer
            if (sheet === 'agent') setAgentId(id); else setProjectId(id); // a project the other agent does not have reads as «not picked»: it is looked up in THAT agent's list
            setOutcome(null); pending.current = null; setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}

function PickRow({ label, value, onOpen, disabled = false, testId }: { label: string; value: string | null; onOpen: () => void; disabled?: boolean; testId: string }) {
  return (
    <Button type="button" variant="outline" disabled={disabled} onClick={onOpen} data-testid={testId}
      className="h-auto min-h-11 w-full justify-between gap-2 px-3 py-2 text-left font-normal">
      <span className="flex min-w-0 flex-col items-start">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="max-w-full truncate text-sm font-medium text-foreground">{value ?? '—'}</span>
      </span>
      <span aria-hidden="true" className="text-muted-foreground">›</span>
    </Button>
  );
}

/** a bottom sheet of names only (no path · no folder name): the whole row is the target (≥ 44 px) and the chosen row is marked by a check, not by colour alone */
function PickSheet({ title, rows, selected, onPick, onClose }: { title: string; rows: Array<{ id: string; name: string }>; selected: string | null; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-end bg-black/40" data-testid="onboarding-phone-sheet" onClick={onClose}>
      <Card className="max-h-[70vh] w-full overflow-y-auto rounded-b-none p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-base font-semibold text-foreground">{title}</h2>
        <ul role="listbox" aria-label={title} className="space-y-1">
          {rows.map((r) => (
            <li key={r.id}>
              <Button type="button" variant="ghost" role="option" aria-selected={r.id === selected} onClick={() => onPick(r.id)} data-testid="onboarding-phone-sheet-row"
                className={`h-auto min-h-11 w-full justify-between px-3 py-2 text-left text-sm ${r.id === selected ? 'bg-muted font-semibold' : 'font-normal'}`}>
                <span className="truncate">{r.name}</span>
                {r.id === selected ? <span aria-hidden="true">✓</span> : null}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
