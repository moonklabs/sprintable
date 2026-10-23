'use client';

// story #4733 (S4b · copy yuna/4733-phone-clock-copy-1020.md · design dan/4733-phone-clock-design-1020.md §7): «세션 관리» in the phone app — end and start the sessions
// of a paired computer, all of them or one agent's. The computer's own flow decides (its daemon; the app window may be closed); this screen only looks at the closed
// view it reported and sends the person's signed presses. A row that needs a hand can be filled in here too (S5 · P2): the person types into the fields, the shell signs a hash of exactly
// those fields and the computer writes only them, only into the revision of the row this screen read.
//
// Words: «퇴근» / «출근» are in no string of this screen — the card is «세션 관리»; the buttons [모든 세션 종료] · [모든 세션 시작] · [세션 종료] · [세션 시작].
// Disabled means a visible reason in text next to the button (never `title`); results are `role="status"` lines (not red, no toasts).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { formatViewerDate } from '@/lib/viewer-time-zone';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { beginFlow, endFlow, groupForPress, readStartableKeyed, type Flow, type StartableComputer } from '@/lib/phone-start';
import { checkPress, editClock, pressClock, readClock, type ClockAction, type ClockEditFields, type ClockRead, type ClockView, type Pending, type PressOutcome } from '@/lib/phone-clock';

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

/** the clock view is looked at again this often: quickly while a flow is open or a press is out, slowly otherwise (the computer re-reports every ten minutes) */
export const VIEW_POLL_FAST_MS = 3_000;
export const VIEW_POLL_SLOW_MS = 15_000;
/** the agents' running state (the buttons on each agent's row) is read again this often */
export const LIST_POLL_MS = 15_000;
/** more than this many names → the first three and «외 k» (the Mac's rule) */
const NAMES_MAX = 6;

/** an agent's name as the person knows it: the list prints «Dev · SYJ-MacBook-Pro» — the computer is already the card's head */
const bareName = (name: string, device: string): string => (name.endsWith(` · ${device}`) ? name.slice(0, -(` · ${device}`).length) : name);

/** a press whose end is not known — kept ABOVE the cards so it survives a card leaving (the list turning to «remote control off» and back): coming back, [결과 확인] follows the SAME command */
/** `setups`: every setup of the card that pressed — the lock holds for any card that shares one of them, so a card that splits or regroups meanwhile (the computer\'s Macs differ in what they say) is still locked */
type Held = { pending: Pending; start: boolean; setups?: string[] };

type Section = { kind: 'reading' } | { kind: 'failed' } | { kind: 'none' } | { kind: 'remote_off' } | { kind: 'computers'; computers: StartableComputer[]; phoneKeyId: string };

export function PhoneSessionManagement() {
  const { orgId, orgSyncPending } = useDashboardContext();
  // the list is this organization's: another organization (a client-side switch) REMOUNTS the section, so it starts from a clean slate — nothing of the other one stays
  // drawn or pressable (state is reset by the key, not by a setState in an effect)
  return <SessionsForOrg key={orgId ?? ''} orgId={orgId} orgSyncPending={orgSyncPending === true} />;
}

function SessionsForOrg({ orgId, orgSyncPending }: { orgId: string | undefined; orgSyncPending: boolean }) {
  const [held] = useState(() => new Map<string, Held>()); // one Map for this component's life (read in handlers · written in handlers), by press (idempotency key); this organization's only (another organization remounts this whole component)
  const t = useTranslations('desktop.phoneSessions');
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  const [section, setSection] = useState<Section>({ kind: 'reading' });
  const flowRef = useRef<Flow | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const listBusy = useRef(false); // one list read at a time: a poll does not start another while the last still waits on the bridge (it cannot be cancelled once asked)
  const readList = useCallback(() => {
    if (listBusy.current) return;
    listBusy.current = true;
    if (flowRef.current) { flowRef.current.stopped = true; endFlow(flowRef.current); }
    const flow = beginFlow();
    flowRef.current = flow;
    void readStartableKeyed(phoneCall, () => flow.stopped).catch(() => ({ kind: 'failed' as const })).then((r) => {
      listBusy.current = false;
      endFlow(flow);
      if (flow.stopped || !alive.current) return;
      if (r.kind === 'view') {
        if (!r.view.remote_control) setSection({ kind: 'remote_off' });
        else setSection(r.view.computers.length > 0 ? { kind: 'computers', computers: groupForPress(r.view.computers), phoneKeyId: r.phoneKeyId } : { kind: 'none' }); // story 4734 (B): one card per COMPUTER — the server lists a setup each
      } else if (r.kind === 'no_phone' || r.kind === 'no_screen_lock') setSection({ kind: 'none' }); // paired with nothing: nothing to manage, no line
      else setSection((s) => (s.kind === 'computers' ? s : { kind: 'failed' })); // a later read that failed keeps what is drawn
    });
  }, [phoneCall]);

  useEffect(() => {
    if (!inPhoneApp) return undefined;
    readList();
    const timer = setInterval(readList, LIST_POLL_MS);
    return () => { clearInterval(timer); if (flowRef.current) { flowRef.current.stopped = true; endFlow(flowRef.current); } };
  }, [inPhoneApp, readList]);

  if (!inPhoneApp || section.kind === 'reading' || section.kind === 'none') return null;
  if (section.kind === 'failed') {
    return (
      <section className="space-y-2" data-testid="phone-sessions" aria-labelledby="phone-sessions-heading">
        <h2 id="phone-sessions-heading" className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="phone-sessions-read-failed">
          {t('readFailed')} <Button variant="outline" size="sm" className="min-h-11" onClick={readList}>{t('retry')}</Button>
        </p>
      </section>
    );
  }
  if (section.kind === 'remote_off') {
    return (
      <section className="space-y-2" data-testid="phone-sessions" aria-labelledby="phone-sessions-heading">
        <h2 id="phone-sessions-heading" className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p role="status" className="break-keep text-xs text-muted-foreground" data-testid="phone-sessions-remote-off">{t('remoteOff')}</p>
      </section>
    );
  }
  return (
    <section className="space-y-3" data-testid="phone-sessions" aria-labelledby="phone-sessions-heading">
      <h2 id="phone-sessions-heading" className="text-sm font-semibold text-foreground">{t('title')}</h2>
      {section.computers.map((c) => (
        <ComputerCard key={`${orgId ?? ''}:${c.computer_id ?? c.setup_id}`} computer={c} phoneKeyId={section.phoneKeyId} onChanged={readList} frozen={orgSyncPending} held={held} />
      ))}
    </section>
  );
}

type T = ReturnType<typeof useTranslations>;

type LineKey =
  | 'remoteOff' | 'already' | 'nothingRunning' | 'notOpen' | 'notReady' | 'needsHands' | 'notClockedOut' | 'unknownAgent' | 'alreadyRunning' | 'expired' | 'expiredStart' | 'expiredEdit' | 'unreachable'
  | 'stale' | 'notEditable' | 'unknownEdit' | 'appTooOld' | 'computerTooBig'
  | 'unknown' | 'unknownStart' | 'notAllowed' | 'notPaired' | 'signInAgain' | 'pairAgain' | 'biometricRequired' | 'noScreenLock' | 'failed';
type Line = { key: LineKey } | null;

const DONE_LINES: Record<string, LineKey> = {
  already: 'already', nothing_running: 'nothingRunning', not_open: 'notOpen', not_ready: 'notReady', needs_hands: 'needsHands', not_clocked_out: 'notClockedOut', unknown_agent: 'unknownAgent', already_running: 'alreadyRunning',
  stale: 'stale', not_editable: 'notEditable',
};

/** the words of a line — every key written out, so a key nobody reads is seen as one */
function resultText(t: T, key: LineKey): string {
  switch (key) {
    case 'remoteOff': return t('remoteOff');
    case 'already': return t('result.already');
    case 'nothingRunning': return t('result.nothingRunning');
    case 'notOpen': return t('result.notOpen');
    case 'notReady': return t('result.notReady');
    case 'needsHands': return t('result.needsHands');
    case 'notClockedOut': return t('result.notClockedOut');
    case 'unknownAgent': return t('result.unknownAgent');
    case 'alreadyRunning': return t('result.alreadyRunning');
    case 'expired': return t('result.expired');
    case 'expiredStart': return t('result.expiredStart');
    case 'expiredEdit': return t('result.expiredEdit');
    case 'unreachable': return t('result.unreachable');
    case 'stale': return t('result.stale');
    case 'notEditable': return t('result.notEditable');
    case 'unknownEdit': return t('result.unknownEdit');
    case 'appTooOld': return t('result.appTooOld');
    case 'computerTooBig': return t('result.computerTooBig');
    case 'unknown': return t('result.unknown');
    case 'unknownStart': return t('result.unknownStart');
    case 'notAllowed': return t('result.notAllowed');
    case 'notPaired': return t('result.notPaired');
    case 'signInAgain': return t('result.signInAgain');
    case 'pairAgain': return t('result.pairAgain');
    case 'biometricRequired': return t('result.biometricRequired');
    case 'noScreenLock': return t('result.noScreenLock');
    case 'failed': return t('result.failed');
  }
}

/** every end of a press is one line (or none): `ok` changes the card itself, a «no» of the person or a leaving screen says nothing */
function lineOf(o: PressOutcome, start: boolean, edit = false): Line {
  switch (o.kind) {
    case 'done': return DONE_LINES[o.result] ? { key: DONE_LINES[o.result]! } : null;
    case 'unreachable': return { key: 'unreachable' }; // the server refused before making anything: certainly nothing happened, but it is not the «never taken» proof
    case 'expired': return { key: edit ? 'expiredEdit' : start ? 'expiredStart' : 'expired' };
    case 'unknown': return { key: edit ? 'unknownEdit' : start ? 'unknownStart' : 'unknown' };
    case 'remote_off': return { key: 'remoteOff' }; // (the section turns to its own remote-off line at the next list read)
    case 'not_allowed': return { key: 'notAllowed' };
    case 'not_paired': return { key: 'notPaired' };
    case 'signed_out': return { key: 'signInAgain' };
    case 'not_registered': case 'key_invalidated': return { key: 'pairAgain' };
    case 'biometric_required': return { key: 'biometricRequired' };
    case 'no_screen_lock': return { key: 'noScreenLock' };
    case 'app_too_old': return { key: 'appTooOld' };
    case 'computer_too_big': return { key: 'computerTooBig' };
    case 'cancelled': case 'stopped': return null;
    default: return { key: 'failed' };
  }
}

function ComputerCard({ computer, phoneKeyId, onChanged, frozen, held }: { computer: StartableComputer; phoneKeyId: string; onChanged: () => void; frozen: boolean; held: Map<string, Held> }) {
  const t = useTranslations('desktop.phoneSessions');
  const locale = useLocale();
  const { phoneCall } = usePhoneBridge();
  // what was read belongs to the setup it was read FROM: when the setup named for the card changes (the first reachable one drops off), the old answer — its counts included — is not the card's any more
  const [readState, setReadState] = useState<{ setup: string; read: ClockRead } | null>(null);
  const read: ClockRead | null = readState !== null && readState.setup === computer.setup_id ? readState.read : null;
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<Line>(null);
  // story 4734 (B): the card is the COMPUTER's (its setups together); the setup named for the card itself is the first reachable one and may change between two reads — what is held, is held by the computer
  const markable = computer.computer_id !== undefined; // an older server names no computer: the entry is its own and a press is the one-setup press it always was
  const mySetups = [computer.setup_id, ...computer.agents.map((a) => a.setup_id).filter((s): s is string => typeof s === 'string')];
  const sharesSetup = (h: Held) => (h.setups ?? [h.pending.setupId]).some((s) => mySetups.includes(s));
  const heldHere = (): Held | null => { for (const h of held.values()) if (sharesSetup(h)) return h; return null; };
  const [pending, setPendingState] = useState<Held | null>(() => heldHere());
  const setPending = (h: Held | null) => {
    for (const [k, v] of [...held]) if (sharesSetup(v)) held.delete(k); // (one unknown end per card — and per setup it covers)
    const next = h ? { ...h, setups: mySetups } : null;
    if (next) held.set(next.pending.key, next);
    setPendingState(next);
  };
  const [pressedHere, setPressedHere] = useState(false);
  const [failures, setFailures] = useState(0); // looks in a row that did not answer: the card drawn may no longer be true
  const flows = useRef(new Set<Flow>()); // every press / check out from this card: the card going away stops them all
  const busyRef = useRef(false); // two taps in one tick both read the same render's state: the guard is a ref (one press per tap)
  const alive = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    const mine = flows.current;
    return () => { alive.current = false; if (timerRef.current) clearTimeout(timerRef.current); for (const f of mine) { f.stopped = true; endFlow(f); } mine.clear(); };
  }, []);

  const view: ClockView | null = read?.view ?? null;
  // «pressed on this page» only matters while a flow is open: once the computer is at rest again the next flow is somebody's again
  useEffect(() => { if (view?.mode === 'none') setPressedHere(false); }, [view?.mode]);
  // a flow that closes (the computer's view goes back to rest) has just stopped or started agents: the list of who is running is read again at once — it is read slowly (LIST_POLL_MS) and would draw an
  // agent that is already ended with [End session] for up to a whole poll (seen live: 18:13:52Z, 16 s until the next read). Rest is `none` AND no view at all: the server drops an empty `none` report, so the
  // usual way a flow closes is a view that is `null` (codex round 1)
  const lastMode = useRef<ClockView['mode'] | null | undefined>(undefined); // undefined: nothing read yet
  const hasRead = read !== null;
  useEffect(() => {
    if (!hasRead) return;
    const mode = view?.mode ?? null;
    const wasOpen = lastMode.current !== undefined && lastMode.current !== null && lastMode.current !== 'none';
    if (wasOpen && (mode === null || mode === 'none')) onChanged();
    lastMode.current = mode;
  }, [hasRead, view?.mode, onChanged]);
  const fast = busy || (view !== null && view.mode !== 'none');

  const lookSeq = useRef(0);
  const look = useCallback(async () => {
    const mine = ++lookSeq.current; // only the latest look commits: an older answer arriving late must not overwrite a newer state (remote-off · failures · the view)
    const r = await readClock(computer.setup_id, phoneKeyId, undefined, { computer: markable });
    if (!alive.current || mine !== lookSeq.current) return;
    if (r.kind === 'not_allowed' || r.kind === 'not_paired') { setHidden(true); return; } // not this person's to command / not this phone's: the card is not drawn
    if (r.kind === 'read') { setHidden(false); setReadState({ setup: computer.setup_id, read: r.read }); setFailures(0); } else setFailures((n) => n + 1);
  }, [computer.setup_id, phoneKeyId, markable]);

  // the view is looked at again: quickly while a flow is open or a press is out, slowly otherwise
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      await look();
      if (stop || !alive.current) return;
      timerRef.current = setTimeout(tick, fast ? VIEW_POLL_FAST_MS : VIEW_POLL_SLOW_MS);
    };
    void tick();
    return () => { stop = true; if (timerRef.current) clearTimeout(timerRef.current); };
  }, [look, fast]);

  /** the setup a press names: the card's for the whole computer; for ONE agent the setup THAT agent belongs to — an agent the list does not carry any more (on a computer-wide card) has none: null, never the card's */
  const setupOf = (agentId: string | undefined): string | null => {
    if (agentId === undefined) return computer.setup_id;
    const a = computer.agents.find((x) => x.agent_member_id === agentId);
    return a?.setup_id ?? (markable ? null : computer.setup_id);
  };

  const run = async (action: ClockAction, agentId?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setLine(null);
    const flow = beginFlow();
    flows.current.add(flow);
    const start = action === 'in';
    try {
      // one agent: the setup THAT agent belongs to (the shell and the daemon find it by it); the whole computer: from the card's setup, with the computer mark — the server collects the setups the person may press one at a time
      const own = setupOf(agentId);
      if (own === null) { setLine({ key: 'unknownAgent' }); return; } // (the agent is not on the list any more: no setup to name — nothing is signed)
      const out = await pressClock({ setupId: own, action, ...(agentId ? { agentId } : markable ? { computer: true as const } : {}) }, { phoneCall, flow, newKey });
      if (!alive.current) return;
      if (out.kind === 'unknown') setPending({ pending: out.pending, start }); else setPending(null);
      if (out.kind === 'done' || out.kind === 'unknown') setPressedHere(action === 'out_open' || action === 'in' ? true : pressedHere);
      if (out.kind === 'done' && action === 'out_cancel') setPressedHere(false);
      setLine(lineOf(out, start));
    } finally {
      endFlow(flow);
      flows.current.delete(flow);
      busyRef.current = false;
      if (alive.current) { setBusy(false); void look(); onChanged(); }
    }
  };

  const check = async () => {
    if (!pending || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const flow = beginFlow();
    flows.current.add(flow);
    try {
      const out = await checkPress(pending.pending, { phoneCall, flow, newKey });
      if (!alive.current) return;
      if (out.kind === 'unknown') setPending({ pending: out.pending, start: pending.start }); else setPending(null);
      setLine(lineOf(out, pending.start));
    } finally {
      endFlow(flow);
      flows.current.delete(flow);
      busyRef.current = false;
      if (alive.current) { setBusy(false); void look(); onChanged(); }
    }
  };

  /** S5 · P2: a person's words for one agent's draft. One thing out at a time (the same guard as a press); an unknown end is NOT held like a press's (nothing to redo: the next look shows what the computer has) */
  const edit = async (agentId: string, baseRev: number, fields: ClockEditFields): Promise<PressOutcome> => {
    if (busyRef.current) return { kind: 'stopped' };
    busyRef.current = true;
    setBusy(true);
    setLine(null);
    const flow = beginFlow();
    flows.current.add(flow);
    let out: PressOutcome = { kind: 'failed' };
    try {
      const own = setupOf(agentId);
      if (own === null) { setLine({ key: 'unknownAgent' }); return { kind: 'failed' }; }
      out = await editClock({ setupId: own, agentId, baseRev, fields }, { phoneCall, flow, newKey });
      if (!alive.current) return out;
      setLine(lineOf(out, false, true));
    } finally {
      endFlow(flow);
      flows.current.delete(flow);
      busyRef.current = false;
      if (alive.current) { setBusy(false); void look(); onChanged(); }
    }
    return out;
  };

  const zone = useViewerTimeZone(); // the viewer's own zone (the phone's) — a clock time is the person's, not the server's
  const time = (iso: string | null | undefined): string => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? (formatViewerDate(d, locale, zone, { hour: 'numeric', minute: '2-digit' }) ?? '') : ''; };

  if (hidden) return null;
  if (!read) {
    // the first look has not answered: after a failed one the card says so (with a way to try again) instead of silently not being there
    if (failures < 1) return null;
    return (
      <Card className="break-keep space-y-2 p-4" data-testid="phone-session-card" data-setup={computer.setup_id}>
        <header>
          <p className="text-sm font-semibold text-foreground">{computer.device_name}</p>
          <p className="text-xs text-muted-foreground">{t('title')}</p>
        </header>
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="phone-sessions-stale">
          {t('readFailed')} <Button variant="outline" size="sm" className="min-h-11" onClick={() => void look()}>{t('retry')}</Button>
        </p>
      </Card>
    );
  }
  // an older app on that computer (it has never reported a clock view = no `clock`): a press could only fail — no buttons, one line saying what to do (PO 5585)
  if (!read.supported) {
    return (
      <Card className="break-keep space-y-2 p-4" data-testid="phone-session-card" data-setup={computer.setup_id}>
        <header>
          <p className="text-sm font-semibold text-foreground">{computer.device_name}</p>
          <p className="text-xs text-muted-foreground">{t('title')}</p>
        </header>
        <p role="status" className="text-xs text-muted-foreground" data-testid="phone-sessions-old-app">{t('oldApp')}</p>
      </Card>
    );
  }
  // what is drawn may no longer be true: two looks in a row did not answer, remote control went off, or the organization is being switched — nothing is pressable then
  const stale = failures >= 2;
  const locked = stale || !read.remoteControl || frozen || pending !== null; // an unknown end holds every other press until it is looked into (the next press must not overwrite it)
  const checkLocked = busy || stale || !read.remoteControl || frozen;
  const device = computer.device_name;
  const nameOf = (id: string, serverName: string | null): string => {
    const a = computer.agents.find((x) => x.agent_member_id === id);
    return bareName(serverName ?? a?.name ?? '', device) || '—';
  };
  const mine = computer.agents.filter((a) => a.can_command); // (a computer's setups may differ in who may press them: only these have controls here)
  const runningCount = mine.filter((a) => a.running === true).length;
  const names = (list: string[]): string => (list.length > NAMES_MAX ? t('action.namesMore', { names: list.slice(0, 3).join(' · '), k: list.length - 3 }) : list.join(' · '));

  const elsewhere = view && view.mode !== 'none' && !pressedHere && (view.openedFrom === 'mac' || view.openedFrom === 'phone') ? view.openedFrom : null;

  return (
    <Card className="break-keep space-y-3 p-4" data-testid="phone-session-card" data-setup={computer.setup_id}>
      <header>
        <p className="text-sm font-semibold text-foreground">{device}</p>
        <p className="text-xs text-muted-foreground">{t('title')}</p>
      </header>
      {elsewhere ? <p role="status" className="text-xs text-muted-foreground" data-testid="phone-sessions-elsewhere">{elsewhere === 'mac' ? t('elsewhere.mac') : t('elsewhere.phone')}</p> : null}

      {view?.mode === 'panel' ? (
        <Panel view={view} t={t} nameOf={nameOf} busy={busy || locked} unreachable={!read.reachable} runningCount={runningCount} names={names}
          onSubmit={(agentId) => void run('out_submit', agentId)} onCancel={(agentId) => void run('out_cancel', agentId)} onEdit={edit} />
      ) : view?.mode === 'in' ? (
        <InProgress view={view} t={t} time={time} />
      ) : view?.mode === 'out' && view.out ? (
        <OutCard view={view} t={t} time={time} names={names} busy={busy || locked} unreachable={!read.reachable} onStart={() => void run('in')} />
      ) : (
        <Idle agents={mine} counts={markable ? read.computer : null} countsMissing={markable && read.computer === null} view={view} t={t} time={time} nameOf={nameOf} busy={busy || locked} unreachable={!read.reachable} runningCount={runningCount}
          onEndAll={() => void run('out_open')} onEndOne={(id) => void run('out_open', id)} onStartOne={(id) => void run('in', id)} />
      )}

      {stale ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="phone-sessions-stale">
          {t('readFailed')} <Button variant="outline" size="sm" className="min-h-11" onClick={() => void look()}>{t('retry')}</Button>
        </p>
      ) : null}
      {!read.remoteControl ? <p role="status" className="text-xs text-muted-foreground" data-testid="phone-sessions-card-remote-off">{t('remoteOff')}</p> : null}
      <p role="status" aria-live="polite" className="text-xs text-foreground" data-testid="phone-sessions-line">
        {line ? resultText(t, line.key) : ''}
      </p>
      {pending ? <Button variant="outline" size="sm" className="min-h-11" disabled={checkLocked} onClick={() => void check()} data-testid="phone-sessions-check">{t('result.checkResult')}</Button> : null}
    </Card>
  );
}

function Idle({ agents, counts, countsMissing, view, t, time, nameOf, busy, unreachable, runningCount, onEndAll, onEndOne, onStartOne }: {
  agents: StartableComputer['agents']; counts: { total: number; pressable: number } | null; countsMissing: boolean; view: ClockView | null; t: T; time: (iso: string | null | undefined) => string; nameOf: (id: string, n: string | null) => string; busy: boolean; unreachable: boolean; runningCount: number;
  onEndAll: () => void; onEndOne: (id: string) => void; onStartOne: (id: string) => void;
}) {
  const outs = view?.outs ?? [];
  const endedOnOwn = new Map(outs.map((o) => [o.agentId, o]));
  return (
    <div className="space-y-3">
      {runningCount > 0 ? (
        <div className="space-y-1">
          {/* story 4734 (B): the ONE button of the computer, and — before the person signs — what it reaches: «N개 중 K개» (the server's count of the setups this person may press one at a time) */}
          {counts ? <p className="text-xs text-foreground" data-testid="phone-sessions-end-all-count">{counts.pressable > 0 ? t('endAllCount', { k: counts.pressable, n: counts.total }) : t('endAllNone')}</p> : null}
          {countsMissing ? <p className="text-xs text-muted-foreground" data-testid="phone-sessions-end-all-count-wait">{t('endAllCountWait')}</p> : null}
          {/* the computer-wide button waits for a valid count: a press whose reach the person was not told is not offered */}
          <Button variant="outline" className="min-h-11" disabled={busy || unreachable || countsMissing || (counts !== null && counts.pressable === 0)} onClick={onEndAll} data-testid="phone-sessions-end-all">{t('endAll')}</Button>
        </div>
      ) : null}
      {/* a disabled button always has its reason as text — also the [세션 시작] of an agent that ended on its own */}
      {unreachable && (runningCount > 0 || outs.length > 0) ? <p className="text-xs text-muted-foreground" data-testid="phone-sessions-unreachable">{t('unreachable')}</p> : null}
      <ul className="space-y-2">
        {agents.map((a) => {
          const own = endedOnOwn.get(a.agent_member_id);
          const name = nameOf(a.agent_member_id, null);
          if (a.running === true) {
            return (
              <li key={a.agent_member_id} className="flex items-center justify-between gap-2" data-testid="phone-sessions-agent">
                <span className="text-sm">{name}</span>
                <Button variant="ghost" size="sm" className="min-h-11" disabled={busy || unreachable} aria-label={t('endOneAria', { name })} onClick={() => onEndOne(a.agent_member_id)}>{t('endOne')}</Button>
              </li>
            );
          }
          if (own) {
            return (
              <li key={a.agent_member_id} className="space-y-1" data-testid="phone-sessions-agent-ended">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">{name}</span>
                  <Button variant="ghost" size="sm" className="min-h-11" disabled={busy || unreachable} aria-label={t('startOneAria', { name })} onClick={() => onStartOne(a.agent_member_id)}>{t('startOne')}</Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('endedRow', { time: time(own.at) })}</p>
              </li>
            );
          }
          return null; // never started here / ended another way: the phone has no control for it (its own «시작» from the agent list is a different start)
        })}
      </ul>
    </div>
  );
}

function Panel({ view, t, nameOf, busy, unreachable, runningCount, names, onSubmit, onCancel, onEdit }: {
  view: ClockView; t: T; nameOf: (id: string, n: string | null) => string; busy: boolean; unreachable: boolean; runningCount: number; names: (l: string[]) => string;
  onSubmit: (agentId?: string) => void; onCancel: (agentId?: string) => void;
  onEdit: (agentId: string, baseRev: number, fields: ClockEditFields) => Promise<PressOutcome>;
}) {
  const one = view.scope === 'one';
  const oneRow = one ? view.rows[0] ?? null : null;
  const agentId = oneRow?.agentId;
  const count = view.count ?? { ready: view.rows.filter((r) => r.state === 'ready').length, needsYou: view.rows.filter((r) => r.state === 'needs_you').length, drafting: view.rows.filter((r) => r.state === 'drafting').length };
  const needsNames = view.rows.filter((r) => r.state === 'needs_you').map((r) => nameOf(r.agentId, r.name));
  // the consent: [모두 그대로 인계하고 세션 종료] is on only when EVERY row in front of the person is ready AND shows its first line (an idle row has no draft to show) — judged
  // from the rows themselves, not from the counts (a row the server withheld or dropped must not hide behind «all ready»)
  const everyRowReady = view.rows.length > 0 && view.rows.every((r) => r.state === 'ready' && (r.idle || r.firstLine !== null)) && (!one || view.rows.length === 1);
  // …and the counts the computer sent must agree with the rows in front of the person: all rows ready means the READY count is exactly the number of rows (a count that says more or less than the
  // rows shown — a row dropped on the way, a count that lags — is not a consent to hand over those rows)
  const countsAgree = count.ready === view.rows.length && count.needsYou === 0 && count.drafting === 0;
  const allReady = countsAgree && everyRowReady;
  const unseenLine = view.rows.some((r) => r.state === 'ready' && !r.idle && r.firstLine === null);
  const reason = count.drafting > 0 ? t('action.draftsComing') : count.needsYou > 0 ? t(one ? 'action.needsHandOne' : 'action.needsHand', { m: count.needsYou }) : unseenLine ? t('action.lineHidden') : null;
  // the lead line counts the agents the flow is about — its own rows: the list of who is running can already say none while the ends are being saved (seen live: «stops 0 agents»)
  const idleOnly = one && oneRow?.idle === true;
  return (
    <div className="space-y-3" data-testid="phone-sessions-panel">
      <p className="text-sm font-semibold">{one ? t('panel.titleOne', { name: nameOf(oneRow?.agentId ?? '', oneRow?.name ?? null) }) : t('panel.title')}</p>
      <p className="text-xs text-muted-foreground">{one ? t(idleOnly ? 'panel.leadIdle' : 'panel.leadOne') : t('panel.lead', { n: view.rows.length > 0 ? view.rows.length : runningCount })}</p>
      <p className="text-xs text-muted-foreground">{t('panel.windowClosed')}</p>
      {!one ? <p className="text-xs text-foreground" data-testid="phone-sessions-count">{count.drafting > 0 ? t('panel.countDrafting', { ready: count.ready, needs: count.needsYou, drafting: count.drafting }) : t('panel.count', { ready: count.ready, needs: count.needsYou })}</p> : null}
      <ul className="space-y-2" data-testid="phone-sessions-rows">
        {view.rows.map((r) => <PanelRow key={r.agentId} row={r} t={t} name={nameOf(r.agentId, r.name)} busy={busy} unreachable={unreachable} onEdit={onEdit} />)}
      </ul>
      {count.needsYou > 0 && !one ? <p className="text-xs text-muted-foreground" data-testid="phone-sessions-needs-list">{t('action.needsList', { names: names(needsNames) })}</p> : null}
      {allReady && !one ? <p role="status" className="text-xs text-foreground">{t('action.allReady')}</p> : null}
      {!allReady && reason ? <p className="text-xs text-muted-foreground" data-testid="phone-sessions-reason">{reason}</p> : null}
      {unreachable ? <p className="text-xs text-muted-foreground">{t('unreachable')}</p> : null}
      {one && agentId === undefined ? null : (
      <div className="flex gap-2">
        <Button className="min-h-11" disabled={busy || unreachable || !allReady} onClick={() => onSubmit(agentId)} data-testid="phone-sessions-submit">
          {busy ? t('action.running') : one ? t(idleOnly ? 'action.submitOneIdle' : 'action.submitOne') : t('action.submitAll')}
        </Button>
        <Button variant="outline" className="min-h-11" disabled={busy || unreachable} onClick={() => onCancel(agentId)} data-testid="phone-sessions-cancel">{t('panel.cancel')}</Button>
      </div>
      )}
    </div>
  );
}

function PanelRow({ row, t, name, busy, unreachable, onEdit }: {
  row: ClockView['rows'][number]; t: T; name: string; busy: boolean; unreachable: boolean; onEdit: (agentId: string, baseRev: number, fields: ClockEditFields) => Promise<PressOutcome>;
}) {
  const state = (() => {
    switch (row.state) {
      case 'drafting': return t('row.drafting');
      case 'ready': return row.idle ? t('row.idle') : row.firstLine ? null : t('row.readyNoLine');
      case 'needs_you': return row.idle ? t('row.idle') : row.missing.length > 0 ? t('row.needsEmpty') : t('row.needsNoDraft');
      case 'saving': return t('row.saving');
      case 'saved': return t('row.saved');
      case 'ended': return t('row.ended');
      case 'not_ended': return row.idle ? t('row.idleNotEnded') : t('row.notEnded');
      case 'failed': return t('row.failed');
      default: return null;
    }
  })();
  // the agent's own text: plain characters in a text node — never a link, never HTML; one line, cut by the layout (the server already cut it at 59 + «…»)
  // S5 · P2: a line a person typed (the Mac's or this phone's) is said so in front of it — «고친 글 · …» — it is not the agent's draft
  const line = row.firstLine && (row.state === 'ready' || row.state === 'needs_you' || row.state === 'saving' || row.state === 'failed')
    ? (row.state === 'ready' ? t(row.edited ? 'row.lineEditedReady' : 'row.lineReady', { line: row.firstLine }) : row.edited ? t('row.lineEdited', { line: row.firstLine }) : row.firstLine)
    : null;
  // a draft that is there (not still coming, not an idle session, not through) can be filled in or fixed
  const editable = !row.idle && (row.state === 'ready' || row.state === 'needs_you');
  return (
    <li className="space-y-0.5" data-testid="phone-sessions-row" data-state={row.state}>
      <p className="text-sm">{name}{state ? <span className="text-muted-foreground"> · {state}</span> : null}</p>
      {line ? <p className="truncate text-xs text-muted-foreground" data-testid="phone-sessions-first-line" data-edited={row.edited ? 'true' : 'false'}>{line}</p> : null}
      {editable ? <RowEditor row={row} t={t} name={name} busy={busy} unreachable={unreachable} onEdit={onEdit} /> : null}
    </li>
  );
}

const EDIT_FIELDS = ['done', 'plan', 'blockers'] as const;
/** the Mac's own limit per field (a longer text is refused by the computer's gate and the server) */
export const EDIT_FIELD_MAX = 2000;

/**
 * S5 · P2 — fill in or fix one agent's draft on the phone. The three fields start EMPTY (the phone is not shown their text — only the first line of «한 것»): a field the person types
 * into replaces that whole field on the computer, a field left empty is not sent and stays exactly as it is. The revision the screen read when the editor was opened rides along;
 * if the row moved on since (the computer says `stale`) nothing is written and the person is shown the row as it is now.
 */
function RowEditor({ row, t, name, busy, unreachable, onEdit }: {
  row: ClockView['rows'][number]; t: T; name: string; busy: boolean; unreachable: boolean; onEdit: (agentId: string, baseRev: number, fields: ClockEditFields) => Promise<PressOutcome>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<Record<(typeof EDIT_FIELDS)[number], string>>({ done: '', plan: '', blockers: '' });
  const [baseRev, setBaseRev] = useState(row.rev);
  const fields: ClockEditFields = {};
  for (const k of EDIT_FIELDS) if (text[k].trim() !== '') fields[k] = text[k].trim(); // the ends' blanks are let go before the phone signs: the computer saves the words trimmed, so what is signed is what is stored
  const typed = Object.keys(fields).length > 0;
  const tooLong = EDIT_FIELDS.some((k) => [...text[k]].length > EDIT_FIELD_MAX);
  // literal keys, so the dead-key guard (verify:no-unused-i18n-keys) sees every label is read
  const label = (k: (typeof EDIT_FIELDS)[number]): string => (k === 'done' ? t('edit.field.done') : k === 'plan' ? t('edit.field.plan') : t('edit.field.blockers'));
  const fill = row.state === 'needs_you';
  if (!open) {
    return (
      <Button variant="outline" size="sm" className="min-h-11" disabled={busy || unreachable} aria-label={t(fill ? 'edit.fillAria' : 'edit.fixAria', { name })}
        onClick={() => { setBaseRev(row.rev); setOpen(true); }} data-testid="phone-sessions-edit-open">
        {t(fill ? 'edit.fill' : 'edit.fix')}
      </Button>
    );
  }
  // the row moved on since the editor was opened (the screen read a newer revision): the person is told, and the first [저장] only takes the new revision as the one they have now
  // looked at (the first line above is the row as it is) — it sends nothing; the typed words stay
  const moved = row.rev !== baseRev;
  const save = async () => {
    if (!typed || tooLong) return;
    if (moved) { setBaseRev(row.rev); return; }
    const out = await onEdit(row.agentId, baseRev, fields);
    if (out.kind === 'done' && out.result === 'ok') { setOpen(false); setText({ done: '', plan: '', blockers: '' }); }
    // (`stale` from the computer: the next look brings the new revision and the notice above; nothing was written)
  };
  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="phone-sessions-editor">
      <p className="text-xs text-muted-foreground">{t('edit.lead')}</p>
      {moved ? <p role="status" className="text-xs text-foreground" data-testid="phone-sessions-edit-moved">{t('edit.moved')}</p> : null}
      {EDIT_FIELDS.map((k) => (
        <label key={k} className="block space-y-1 text-xs">
          <span className="font-medium text-foreground">{label(k)}</span>
          <textarea
            className="min-h-16 w-full rounded-md border bg-background p-2 text-base lg:text-sm"
            rows={3}
            maxLength={EDIT_FIELD_MAX * 2}
            value={text[k]}
            placeholder={row.missing.includes(k) ? t('edit.placeholderEmpty') : t('edit.placeholderKeep')}
            onChange={(e) => setText((prev) => ({ ...prev, [k]: e.target.value }))}
            data-testid={`phone-sessions-edit-${k}`}
          />
        </label>
      ))}
      {tooLong ? <p role="status" className="text-xs text-muted-foreground" data-testid="phone-sessions-edit-too-long">{t('edit.tooLong', { max: EDIT_FIELD_MAX })}</p> : null}
      {!typed ? <p className="text-xs text-muted-foreground" data-testid="phone-sessions-edit-nothing">{t('edit.nothingTyped')}</p> : null}
      <div className="flex gap-2">
        <Button className="min-h-11" disabled={busy || unreachable || !typed || tooLong} onClick={() => void save()} data-testid="phone-sessions-edit-save">{busy ? t('edit.saving') : t('edit.save')}</Button>
        <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)} data-testid="phone-sessions-edit-close">{t('edit.close')}</Button>
      </div>
    </div>
  );
}

function OutCard({ view, t, time, names, busy, unreachable, onStart }: { view: ClockView; t: T; time: (iso: string | null | undefined) => string; names: (l: string[]) => string; busy: boolean; unreachable: boolean; onStart: () => void }) {
  const o = view.out!;
  return (
    <div className="space-y-2" data-testid="phone-sessions-out">
      <p className="text-sm font-semibold">{t('out.head', { time: time(o.at) })}</p>
      {o.left.length > 0 ? <p className="text-xs text-foreground">{t('out.names', { names: names(o.left) })}</p> : null}
      {o.alone > 0 ? <p className="text-xs text-muted-foreground" data-testid="phone-sessions-alone">{t('out.alone', { k: o.alone })}</p> : null}
      {o.came > 0 ? <p className="text-xs text-muted-foreground">{t('out.came', { n: o.came })}</p> : null}
      {o.warn === 'many' ? <p className="text-xs text-muted-foreground">{t('out.warnMany', { n: o.came })}</p> : null}
      {o.warn === 'full' ? <p className="text-xs text-muted-foreground">{t('out.warnFull')}</p> : null}
      {o.stillWorking.length > 0 ? <p className="text-xs text-muted-foreground">{t('out.stillWorking', { names: names(o.stillWorking) })}</p> : null}
      {unreachable ? <p className="text-xs text-muted-foreground">{t('unreachable')}</p> : null}
      <Button className="min-h-11" disabled={busy || unreachable} onClick={onStart} data-testid="phone-sessions-start-all">{t('startAll')}</Button>
    </div>
  );
}

function InProgress({ view, t, time }: { view: ClockView; t: T; time: (iso: string | null | undefined) => string }) {
  const i = view.in;
  if (!i) return null;
  return (
    <div className="space-y-1" data-testid="phone-sessions-in">
      {i.starting ? <p className="text-sm">{t('in.starting', { k: i.starting.k, n: i.starting.n })}</p> : null}
      {i.handing ? <p className="text-sm">{t('in.handing', { k: i.handing.k, m: i.handing.m })}</p> : null}
      {!i.starting && !i.handing ? <p className="text-sm">{i.came && i.came.total > 0 ? t('in.startedCame', { time: time(i.at), n: i.came.total }) : t('in.startedNone')}</p> : null}
      {i.failed.length > 0 ? <p className="text-xs text-muted-foreground">{i.failed.map((f) => f.name).join(' · ')} — {t('in.retryAtComputer')}</p> : null}
    </div>
  );
}
