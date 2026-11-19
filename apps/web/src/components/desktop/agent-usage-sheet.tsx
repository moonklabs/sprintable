'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import {
  accountOrdinal, agoOf, loadUsage, untilOf, windowName,
  type Ago, type UsageDeps, type UsageRow, type UsageState, type UsageView, type UsageWindow, type Until, type WindowName,
} from '@/lib/agent-usage';

/**
 * story 4981 (연결 ③ · PR 4) — the «사용량» sheet of a computer's card in the phone app: for each CLI (and account) the computer's host reported, one bar per limit window — whole percent,
 * «N시간 뒤 풀려요», and «마지막으로 본 지 N분 전» (the strip's own words for «last seen»). The numbers are the host's own last words: shown, never decided by. A CLI with no numbers says why in one
 * line (closed list). A computer that is silent right now keeps its last numbers with its time and one line saying it is disconnected. The sheet reads when it opens (a closed sheet reads nothing)
 * and again on [다시 읽기]. The look is the changes sheet's (Dialog · header · scrolling body · footer): no new shape.
 */
const MAX_TIMER = 2 ** 31 - 1; // setTimeout's own ceiling (a reset further away than ~24 days is checked again when the sheet is read next)
/** the soonest reset time (ms) after `now` among the windows drawn — the moment a bar has to turn into «풀렸어요»; null when none is ahead */
function nextReset(view: UsageView, now: number): number | null {
  let best: number | null = null;
  for (const row of view.rows) for (const w of row.windows) {
    const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (Number.isFinite(at) && at > now && (best === null || at < best)) best = at;
  }
  return best;
}
const defaultDeps = (): UsageDeps => ({ fetch: (agentId) => fetchWithAuth(`/api/agents/${encodeURIComponent(agentId)}/desktop-usage`), now: () => Date.now() });
/** the CLI's own names are not translated (brand names — the same in every language) */
const RUNTIME_NAME = { claude: 'Claude', codex: 'Codex' } as const;

export function AgentUsageSheet({ agentId, open, onOpenChange, deps }: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** tests: the network and the clock */
  deps?: UsageDeps;
}) {
  const t = useTranslations('desktop.phoneSessions.usage');
  // the answer belongs to ONE opening (tagged with its run): a closed sheet — or an older run — shows nothing; nothing is reset from inside an effect
  const [shown, setShown] = useState<{ run: number; state: UsageState; at: number }>({ run: 0, state: { kind: 'failed' }, at: 0 });
  // the clock the words are counted from: the moment of the read, moved on to the next reset time while the sheet stays open (so a window that is freed while it is on the screen turns into «풀렸어요» at once, by the same calculation)
  const [clock, setClock] = useState<{ run: number; at: number } | null>(null);
  const [active, setActive] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) { setWasOpen(open); if (!open) setActive(0); }
  const run = useRef(0);

  const start = useCallback(() => {
    const mine = ++run.current;
    const d = deps ?? defaultDeps();
    setActive(mine);
    void loadUsage(agentId, d).then((state) => { if (run.current === mine) setShown({ run: mine, state, at: d.now() }); });
  }, [agentId, deps]);

  useEffect(() => {
    if (!open) return;
    start();
    const counter = run; // a counter, not a DOM node: the cleanup bumps the CURRENT value on purpose
    return () => { counter.current++; };
  }, [open, start]);

  const reading = open && active !== 0 && shown.run !== active;
  const state: UsageState | null = open && shown.run === active && active !== 0 ? shown.state : null;
  const view = state?.kind === 'ok' ? state.view : null;
  const now = clock && clock.run === shown.run && clock.at > shown.at ? clock.at : shown.at;

  useEffect(() => {
    if (!view) return;
    const d = deps ?? defaultDeps();
    const next = nextReset(view, now);
    if (next === null) return;
    const id = setTimeout(() => setClock({ run: shown.run, at: Math.max(next, d.now()) }), Math.min(Math.max(next - d.now(), 0) + 50, MAX_TIMER));
    return () => clearTimeout(id);
  }, [view, now, deps, shown.run]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-2xl" data-testid="agent-usage-sheet">
        <DialogHeader>
          <DialogTitle data-testid="agent-usage-title">{view?.deviceName ? t('title', { device: view.deviceName }) : t('titleNoDevice')}</DialogTitle>
          <DialogDescription className="break-keep" data-testid="agent-usage-lead">{t('lead')}</DialogDescription>
        </DialogHeader>
        <div className="focus-inset min-h-0 flex-1 overflow-y-auto" data-testid="agent-usage-body">
          {reading || (open && state === null) ? <p role="status" className="px-4 py-6 text-ds-small text-ds-ink-3" data-testid="agent-usage-loading">{t('loading')}</p> : null}
          {state?.kind === 'failed' || state?.kind === 'gone' ? <p role="alert" className="break-keep px-4 py-6 text-ds-body text-ds-ink-2" data-testid="agent-usage-failed">{t('failed')}</p> : null}
          {view ? <Body view={view} now={now} t={t} /> : null}
        </div>
        <DialogFooter>
          {state ? <Button variant="outline" onClick={start} data-testid="agent-usage-reload">{t('retry')}</Button> : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type T = ReturnType<typeof useTranslations>;

function Body({ view, now, t }: { view: UsageView; now: number; t: T }) {
  if (!view.remoteControl) return <p role="status" className="break-keep px-4 py-6 text-ds-body text-ds-ink-2" data-testid="agent-usage-remote-off">{t('remoteOff')}</p>;
  if (!view.hasComputer) return <p role="status" className="break-keep px-4 py-6 text-ds-body text-ds-ink-2" data-testid="agent-usage-no-computer">{t('noComputer')}</p>;
  return (
    <div className="space-y-4 px-4 py-4">
      {!view.connected ? <p role="status" className="break-keep text-ds-small text-ds-ink-3" data-testid="agent-usage-disconnected">{t('disconnected')}</p> : null}
      {view.rows.length === 0 ? <p className="break-keep text-ds-body text-ds-ink-2" data-testid="agent-usage-empty">{t('empty')}</p> : null}
      {view.rows.map((row) => <UsageSection key={`${row.runtime}:${row.account}`} row={row} ordinal={accountOrdinal(view.rows, row)} now={now} t={t} />)}
    </div>
  );
}

function windowText(t: T, n: WindowName): string {
  switch (n.key) {
    case 'five_hour': return t('window.five_hour');
    case 'seven_day': return t('window.seven_day');
    case 'min': return t('window.min', { n: n.n });
    case 'hour': return t('window.hour', { n: n.n });
    case 'day': return t('window.day', { n: n.n });
    default: return t('window.unknown');
  }
}
function untilText(t: T, u: Until | null): string {
  if (u === null || u.unit === 'passed') return t('resets.unknown');
  switch (u.unit) {
    case 'min': return t('resets.min', { n: u.n });
    case 'hour': return t('resets.hour', { n: u.n });
    default: return t('resets.day', { n: u.n });
  }
}
function agoText(t: T, a: Ago | null): string | null {
  if (a === null) return null;
  switch (a.unit) {
    case 'now': return t('seen.now');
    case 'min': return t('seen.min', { n: a.n });
    case 'hour': return t('seen.hour', { n: a.n });
    default: return t('seen.day', { n: a.n });
  }
}

function UsageSection({ row, ordinal, now, t }: { row: UsageRow; ordinal: number | null; now: number; t: T }) {
  const runtime = RUNTIME_NAME[row.runtime];
  const heading = ordinal === null ? runtime : t('account', { runtime, n: ordinal });
  const seen = agoText(t, agoOf(row.seenAt, now));
  return (
    <section aria-label={heading} className="space-y-2" data-testid="agent-usage-row" data-runtime={row.runtime}>
      <h3 className="text-ds-body font-semibold text-ds-ink">{heading}</h3>
      {row.state === 'windows' ? row.windows.map((w, i) => <WindowBar key={i} w={w} now={now} t={t} />) : (
        <p className="break-keep text-ds-body text-ds-ink-2" data-testid="agent-usage-why" data-why={row.why ?? ''}>{row.why === 'api_key' ? t('why.api_key') : row.why === 'not_read' ? t('why.not_read') : null}</p>
      )}
      {seen ? <p className="text-ds-small text-ds-ink-3" data-testid="agent-usage-seen">{seen}</p> : null}
    </section>
  );
}

function WindowBar({ w, now, t }: { w: UsageWindow; now: number; t: T }) {
  const name = windowText(t, windowName(w));
  const until = untilOf(w.resetsAt, now);
  // a window whose reset time has passed is no longer what the number says: no percent, no bar — one line (the CLI says the new number at its next session)
  if (until?.unit === 'passed') {
    return (
      <div className="space-y-1" data-testid="agent-usage-window" data-stale="true">
        <div className="text-ds-body text-ds-ink">{name}</div>
        <p className="break-keep text-ds-small text-ds-ink-3" data-testid="agent-usage-stale">{t('stale')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1" data-testid="agent-usage-window">
      <div className="flex items-baseline justify-between gap-2 text-ds-body text-ds-ink">
        <span>{name}</span>
        <span data-testid="agent-usage-percent">{t('percent', { n: w.usedPercent })}</span>
      </div>
      <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.usedPercent} aria-label={t('percentAria', { name, n: w.usedPercent })}
        className="h-2 w-full overflow-hidden rounded-full bg-ds-surface-sunk" data-testid="agent-usage-bar">
        <div className="h-full bg-ds-action" style={{ width: `${w.usedPercent}%` }} />
      </div>
      <p className="text-ds-small text-ds-ink-3" data-testid="agent-usage-resets">{untilText(t, until)}</p>
    </div>
  );
}
