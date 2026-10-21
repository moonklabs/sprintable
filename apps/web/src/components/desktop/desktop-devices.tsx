'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { InvisibleSample, useViewerTimeZone } from '@/components/viewer-time-zone';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';
import { pickIGaJosa } from '@/lib/korean-particle';
import {
  canDisconnect, canManageDevices, deviceAgentCount, deviceAgents, agentNameList, deviceDateOptions, linkedSetupId, readRevoked, type DesktopDevice,
} from '@/lib/desktop-devices';
import {
  canDisconnectComputer, computerAgents, computerOfSetup, computerSetupCount, liveSetups, markComputerDisconnected, markSetupDisconnected, orderComputers,
  pairedPhoneGap, readComputerRevoked, readComputers, type ComputerSetup, type DesktopComputer,
} from '@/lib/desktop-computers';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { useFlatHref } from '@/hooks/use-flat-href';
import { stageRoleLabel } from '@/lib/stage-role';

/**
 * story #4424 — «연결된 기기» on /desktop (Yuna 0ebe65ef · PO adopted 15:42Z; its copy table is the source for every string).
 * story 4734 — one line per COMPUTER (one Mac · one person · one organization), its setups in the fold (Yuna 4734-pairing-unit-copy-1020.md): a Mac that has
 * made a hundred setups is one line, «이 컴퓨터 모두 끊기» ends every connected setup of it at once (all or none), and each setup row keeps its own «연결 끊기».
 * An org owner/admin sees the org's computers; a member sees the heading and one line — the list is asked for only after the role says owner/admin
 * (no 403, no error screen). No org column: the list is this org's only.
 */
type Asking = { kind: 'setup'; computerId: string; setupId: string } | { kind: 'computer'; computerId: string };
type Done = { kind: 'one'; device: string; already: boolean } | { kind: 'all'; device: string; n: number; already: boolean };

export function DesktopDevices() {
  const t = useTranslations('desktop.devices');
  const tDesktop = useTranslations('desktop');
  const { orgId, orgMemberships } = useDashboardContext();
  const manage = canManageDevices(orgMemberships.find((o) => o.orgId === orgId)?.role);
  const [computers, setComputers] = useState<DesktopComputer[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<'one' | 'all' | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // every list read gets a number; only the latest may write — a read started before an org switch (the retry button, the
  // re-read after an unreadable disconnect answer) that answers after it is the previous org's and is dropped (Qadir 4839 T1 ②)
  const readSeq = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  // after a computer-wide disconnect the focus goes to the next computer's line (the first other connected one, else the first other), the heading when there is none
  useEffect(() => {
    if (focusAfter === null || !computers) return;
    const next = orderComputers(computers).find((c) => c.computer_id !== focusAfter);
    const row = next ? sectionRef.current?.querySelector<HTMLElement>(`[data-computer-id="${next.computer_id}"] summary`) : null;
    (row ?? headingRef.current)?.focus();
    setFocusAfter(null);
  }, [focusAfter, computers]);

  // the list is this org's: read again whenever the org changes (Qadir 4830 ① — a client-side org switch kept /desktop mounted
  // and showed the previous org's devices), starting from a clean slate so nothing of the other org shows meanwhile
  const load = useCallback(() => {
    setLoadFailed(false);
    setComputers(null); setDone(null); setAsking(null); setFailed(null);
    const mine = ++readSeq.current;
    fetchWithAuth('/api/desktop/computers')
      .then(readComputers)
      .catch(() => null)
      .then((list) => {
        if (readSeq.current !== mine) return;
        if (list) setComputers(list.computers);
        else setLoadFailed(true);
      });
    return () => { if (readSeq.current === mine) readSeq.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the request is scoped by the session's org (the token switch-org reissues); orgId says when it changed
  }, [orgId]);

  useEffect(() => (manage ? load() : undefined), [manage, load]);

  // story 4675 (F2): the workforce detail links here as `/desktop#device=<setup_id>` — that computer opens and the setup's row comes into view once the
  // list is here (read after the list, so a link that arrives before the rows still finds its row)
  const [linked, setLinked] = useState<string | null>(null);
  useEffect(() => { if (computers) setLinked(linkedSetupId(window.location.hash)); }, [computers]);

  // what the dialog is about is read from the CURRENT list by id — a list read again under an open dialog (a refused disconnect) keeps its numbers true
  const askedComputer = asking ? computers?.find((c) => c.computer_id === asking.computerId) ?? null : null;
  const askedSetup = asking?.kind === 'setup' ? askedComputer?.setups.find((s) => s.setup_id === asking.setupId) ?? null : null;

  /** the list read again under an open dialog: awaited by the caller (the dialog stays busy until it is here) — a newer read or an org switch drops it as the others */
  const rereadComputers = async () => {
    const mine = ++readSeq.current;
    const list = await fetchWithAuth('/api/desktop/computers').then(readComputers).catch(() => null);
    if (readSeq.current !== mine) return;
    if (list) setComputers(list.computers);
  };

  const disconnectSetup = async (computer: DesktopComputer, setup: ComputerSetup) => {
    setBusy(true);
    setFailed(null);
    const seq = readSeq.current; // an org switch (or a re-read) bumps it: the answer of a disconnect asked in the previous org is that org's — it touches nothing here
    try {
      const res = await fetchWithAuth(`/api/desktop/setups/${setup.setup_id}`, { method: 'DELETE' });
      if (readSeq.current !== seq) return;
      if (!res.ok) throw new Error(String(res.status));
      // the server says who disconnected it and when — «you» only when this call did it (Qadir 4830 ④)
      const revoked = await readRevoked(res);
      if (readSeq.current !== seq) return;
      if (revoked) {
        setComputers((list) => (list ? markSetupDisconnected(list, setup.setup_id, revoked.revokedAt, revoked.revokedByName) : list));
        setDone({ kind: 'one', device: computer.device_name, already: revoked.already });
      } else {
        // an answer we cannot read: the result is unknown — the re-read list says what happened, the line claims nothing
        // (Qadir 4839 T1 ①)
        load();
      }
      setAsking(null);
      headingRef.current?.focus(); // the pressed button is gone — focus goes to the list heading
    } catch {
      setFailed('one'); // said inside the dialog, which stays open
    } finally {
      setBusy(false);
    }
  };

  const disconnectAll = async (computer: DesktopComputer) => {
    setBusy(true);
    setFailed(null);
    const seq = readSeq.current; // (as in disconnectSetup)
    try {
      const res = await fetchWithAuth(`/api/desktop/computers/${computer.computer_id}`, { method: 'DELETE' });
      if (readSeq.current !== seq) return;
      if (!res.ok) {
        if (res.status === 409) await rereadComputers(); // setups came or went while it was being locked: nothing was changed — the list is read again (the dialog stays busy meanwhile, so a press cannot race the read) and keeps the new numbers
        throw new Error(String(res.status));
      }
      const revoked = await readComputerRevoked(res);
      if (readSeq.current !== seq) return;
      if (revoked) {
        setComputers((list) => (list ? markComputerDisconnected(list, computer.computer_id, revoked) : list));
        setDone({ kind: 'all', device: computer.device_name, n: revoked.setups, already: revoked.already });
        setFocusAfter(computer.computer_id); // the pressed button is gone: focus goes to the next computer's line (Yuna §A-4), or the heading when there is none
      } else {
        load(); // unreadable answer: the re-read list says what happened
        headingRef.current?.focus();
      }
      setAsking(null);
    } catch {
      setFailed('all');
    } finally {
      setBusy(false);
    }
  };

  // the dialogs say the agents of what is about to stop; the particle follows that word (ko — en ignores {josa})
  const setupAgents = t('agents', { count: askedSetup ? deviceAgentCount(askedSetup) : 0 });
  const askedNames = askedSetup ? agentNameList(askedSetup) : [];
  const allAgents = t('agents', { count: askedComputer ? computerAgents(askedComputer).length : 0 });
  const otherLive = askedComputer && askedSetup && canDisconnect(askedSetup) ? liveSetups(askedComputer).filter((s) => s.setup_id !== askedSetup.setup_id).length : 0;
  const onlyThis = asking?.kind === 'setup' && otherLive > 0;
  const doneText = !done ? null
    : done.kind === 'all' ? t(done.already ? 'alreadyDone' : 'allDone', { device: done.device, n: done.n })
    : t(done.already ? 'alreadyDone' : 'done', { device: done.device });

  return (
    <section ref={sectionRef} className="space-y-2" data-testid="desktop-devices" aria-labelledby="desktop-devices-heading">
      <h2 id="desktop-devices-heading" ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-foreground outline-none">
        {t('title')}
      </h2>
      {!manage ? (
        <p className="text-xs text-muted-foreground" data-testid="desktop-devices-member">{t('member')}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
          <p aria-live="polite" className="break-keep text-xs text-foreground" data-testid="desktop-devices-done">{doneText}</p>
          {loadFailed ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="desktop-devices-load-failed">
              {t('loadFailed')}
              <Button variant="outline" size="sm" onClick={() => load()}>{t('retry')}</Button>
            </p>
          ) : computers === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {tDesktop('loading')}
            </p>
          ) : computers.length === 0 ? (
            <Card className="border-dashed px-4 py-5" data-testid="desktop-devices-empty">
              <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('emptyBody')}</p>
            </Card>
          ) : (
            <Card className="overflow-hidden p-0">
              <ul className="divide-y divide-border">
                {orderComputers(computers).map((c) => (
                  <ComputerRow
                    key={c.computer_id} computer={c} linked={linked}
                    onDisconnectAll={() => { setFailed(null); setAsking({ kind: 'computer', computerId: c.computer_id }); }}
                    onDisconnectSetup={(s) => { setFailed(null); setAsking({ kind: 'setup', computerId: c.computer_id, setupId: s.setup_id }); }}
                  />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <Dialog open={asking !== null && askedComputer !== null} onOpenChange={(open) => { if (!open && !busy) setAsking(null); }}>
        <DialogContent showCloseButton={false} initialFocus={cancelRef}>
          {asking?.kind === 'computer' && askedComputer ? (
            <>
              <DialogHeader>
                <DialogTitle className="truncate" title={askedComputer.device_name}>{t('allTitle', { device: askedComputer.device_name })}</DialogTitle>
                {/* the scary act is said big, once, in plain words: «되돌릴 수 없어요», the scope as a number, the paired phones (Yuna 4734 §A-3) */}
                <DialogDescription className="space-y-2 break-keep" data-testid="desktop-computers-confirm-body">
                  <span className="block font-semibold text-foreground" data-testid="desktop-computers-confirm-line">{t('allIrreversible')}</span>
                  <span className="block" data-testid="desktop-computers-confirm-line">{t('allScope', { n: computerSetupCount(askedComputer), agents: allAgents, josa: pickIGaJosa(allAgents) })}</span>
                  <span className="block" data-testid="desktop-computers-confirm-line">{t('allPhones')}</span>
                  <span className="block" data-testid="desktop-computers-confirm-line">{t('allStays')}</span>
                  <span className="block" data-testid="desktop-computers-confirm-line">{t('allBack')}</span>
                </DialogDescription>
              </DialogHeader>
              {failed === 'all' ? <p role="alert" className="text-sm text-destructive" data-testid="desktop-devices-failed">{t('allFailed')}</p> : null}
              <DialogFooter>
                <Button ref={cancelRef} variant="outline" disabled={busy} onClick={() => setAsking(null)}>{t('cancel')}</Button>
                <Button variant="destructive" disabled={busy} onClick={() => void disconnectAll(askedComputer)} data-testid="desktop-computers-confirm-all">
                  {busy ? t('disconnecting') : t('allButton', { n: computerSetupCount(askedComputer) })}
                </Button>
              </DialogFooter>
            </>
          ) : asking?.kind === 'setup' && askedComputer && askedSetup ? (
            <>
              <DialogHeader>
                <DialogTitle className="truncate" title={askedComputer.device_name}>{t('confirmTitle', { device: askedComputer.device_name })}</DialogTitle>
                {/* the v3 body is long (story #4434) — keep Korean words whole at 360, as the list rows do (Yuna) */}
                {askedNames.length > 0 ? <p className="break-keep text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="desktop-devices-confirm-agents">{t('confirmAgentsLine', { names: namesText(askedNames, t) })}</p> : null}
                <DialogDescription className="break-keep" data-testid="desktop-devices-confirm-body">
                  {t('confirmBodyHead', { agents: setupAgents, josa: pickIGaJosa(setupAgents) })}{' '}
                  {onlyThis ? <><strong className="font-semibold text-foreground" data-testid="desktop-devices-only-this">{t('confirmOnlyThis', { m: otherLive })}</strong>{' '}</> : null}
                  {t('confirmBodyTail')}
                </DialogDescription>
              </DialogHeader>
              {failed === 'one' ? <p role="alert" className="text-sm text-destructive" data-testid="desktop-devices-failed">{t('failed')}</p> : null}
              <DialogFooter>
                <Button ref={cancelRef} variant="outline" disabled={busy} onClick={() => setAsking(null)}>{t('cancel')}</Button>
                <Button variant="destructive" disabled={busy} onClick={() => void disconnectSetup(askedComputer, askedSetup)} data-testid="desktop-devices-confirm">
                  {busy ? t('disconnecting') : t('disconnect')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <DialogHeader><DialogTitle>{t('title')}</DialogTitle><DialogDescription>{' '}</DialogDescription></DialogHeader>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** a computer's line: its name · state · counts, a fold for its setups, and «이 컴퓨터 모두 끊기» (story 4734) */
function ComputerRow({ computer, linked, onDisconnectAll, onDisconnectSetup }: {
  computer: DesktopComputer; linked: string | null; onDisconnectAll: () => void; onDisconnectSetup: (s: ComputerSetup) => void;
}) {
  const t = useTranslations('desktop.devices');
  const format = useFormatter();
  const off = computer.state === 'disconnected';
  const holdsLink = !!linked && computerOfSetup([computer], linked) !== undefined;
  const at = off ? computer.setups.find((s) => s.revoked_at)?.revoked_at ?? null : computer.confirmed_at;
  const who = off ? computer.setups.find((s) => s.revoked_by_name)?.revoked_by_name ?? null : computer.confirmed_by_name ?? null;
  const tz = useViewerTimeZone();
  const date = at ? format.dateTime(new Date(at), { ...deviceDateOptions(at, new Date(), tz ?? 'UTC'), timeZone: tz ?? 'UTC' }) : null;
  const dateText = date ? t(off ? 'disconnectedOn' : 'connectedOn', { date }) : null;
  const stateLabel = computer.state === 'handed_over' ? t('state.handed_over')
    : computer.state === 'waiting_for_app' ? t('state.waiting_for_app')
    : computer.state === 'not_handed_over' ? t('state.not_handed_over')
    : t('state.disconnected');
  const gap = pairedPhoneGap(computer);
  return (
    <li data-testid="desktop-computer-row" data-state={computer.state} data-computer-id={computer.computer_id}>
      <details className="group" open={holdsLink || undefined} data-testid="desktop-computer-details">
        <summary
          className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"
          aria-label={t('expandSetupsAria', { device: computer.device_name })}
        >
          <div className="min-w-0">
            <p className={`flex flex-wrap items-center gap-2 text-sm ${off ? 'font-medium text-muted-foreground' : 'font-semibold text-foreground'}`}>
              {/* the chevron and the name are one item: a long name wraps inside its own box and the state drops to the next line, never the chevron alone above the name */}
              <span className="flex min-w-0 max-w-full items-center gap-2">
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
                <span className="min-w-0 break-words" data-testid="desktop-computer-name">{computer.device_name}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="desktop-computer-state">
                <StateDot state={computer.state} />
                <span className={computer.state === 'handed_over' ? 'text-success' : undefined}>{stateLabel}</span>
              </span>
            </p>
            <p className="mt-0.5 break-keep text-xs text-muted-foreground" data-testid="desktop-computer-meta">
              {t('agents', { count: computerAgents(computer).length })}{' · '}{t('setupCount', { n: computerSetupCount(computer) })}
              {dateText ? <>{' · '}{tz ? dateText : <InvisibleSample>{dateText}</InvisibleSample>}</> : null}
              {who ? <>{' · '}{t(off ? 'disconnectedBy' : 'connectedBy', { name: who })}</> : null}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground" aria-hidden>
              <span className="group-open:hidden">{t('setupsShow')}</span>
              <span className="hidden group-open:inline">{t('setupsHide')}</span>
            </p>
          </div>
          {canDisconnectComputer(computer) ? (
            // inside a <summary> a button's click would also open/close the row — the button keeps its one meaning
            <Button variant="outline" size="sm" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDisconnectAll(); }} aria-label={t('disconnectAllAria', { device: computer.device_name })} data-testid="desktop-computer-disconnect-all">
              {t('disconnectAll')}
            </Button>
          ) : null}
        </summary>
        {gap ? <p className="break-keep px-4 pb-2 text-xs text-muted-foreground" data-testid="desktop-computer-pair-gap">{t('pairGap', gap)}</p> : null}
        <ul className="divide-y divide-border border-t border-border bg-muted/20" data-testid="desktop-computer-setups">
          {computer.setups.map((s) => (
            <DeviceRow key={s.setup_id} device={s} deviceName={computer.device_name} linked={s.setup_id === linked} onDisconnect={() => onDisconnectSetup(s)} />
          ))}
        </ul>
      </details>
    </li>
  );
}

/** story 4734 (Yuna §A-2b): one or two names joined « · »; three or more — the first two and «외 {k}» («and {k} more») */
function namesText(names: string[], t: (key: string, values?: Record<string, string | number>) => string): string {
  return names.length >= 3 ? t('namesMore', { a: names[0]!, b: names[1]!, k: names.length - 2 }) : names.join(' · ');
}

function DeviceRow({ device, deviceName, linked = false, onDisconnect }: { device: DesktopDevice; deviceName: string; linked?: boolean; onDisconnect: () => void }) {
  const t = useTranslations('desktop.devices');
  const tOrg = useTranslations('organization');
  const flatHref = useFlatHref();
  const format = useFormatter();
  const off = device.state === 'disconnected';
  const count = deviceAgentCount(device);
  const names = agentNameList(device); // the row says WHICH setup it is by its agents' names (no names known → the count, as before)
  // story 4675 (F2 · Yuna §I ④): the row opens to its agents (name → the workforce page · role); a device with no agent is the
  // row alone. A link from the workforce detail (`#device=`) opens it and brings it into view.
  const agents = deviceAgents(device);
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => { if (linked) rowRef.current?.scrollIntoView?.({ block: 'center' }); }, [linked]);
  const at = off ? device.revoked_at : device.confirmed_at;
  const who = off ? device.revoked_by_name : device.confirmed_by_name;
  // story #4443 — in the viewer's zone (was next-intl's, which nothing set: the server's UTC); unknown yet → held, not drawn
  const tz = useViewerTimeZone();
  const date = at ? format.dateTime(new Date(at), { ...deviceDateOptions(at, new Date(), tz ?? 'UTC'), timeZone: tz ?? 'UTC' }) : null;
  const dateText = date ? t(off ? 'disconnectedOn' : 'connectedOn', { date }) : null;
  const stateLabel = device.state === 'handed_over' ? t('state.handed_over')
    : device.state === 'waiting_for_app' ? t('state.waiting_for_app')
    : device.state === 'not_handed_over' ? t('state.not_handed_over')
    : t('state.disconnected');
  const head = (
    <>
      <div className="min-w-0">
        <p className={`flex flex-wrap items-center gap-2 text-sm ${off ? 'font-medium text-muted-foreground' : 'font-semibold text-foreground'}`}>
          {agents.length > 0 ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden /> : null}
          {/* story 4734: the computer's line carries the Mac's name — a setup row inside it does not repeat it */}
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="desktop-device-state">
            <StateDot state={device.state} />
            <span className={device.state === 'handed_over' ? 'text-success' : undefined}>{stateLabel}</span>
          </span>
        </p>
        {device.state === 'not_handed_over' ? <p className="mt-0.5 break-keep text-xs text-muted-foreground">{t('notHandedOverWhy')}</p> : null}
        <p className="mt-0.5 break-keep text-xs text-muted-foreground" data-testid="desktop-device-meta">
          {names.length > 0 ? <span className="[overflow-wrap:anywhere]" data-testid="desktop-device-names">{namesText(names, t)}</span> : t('agents', { count })}
          {dateText ? <>{' · '}{tz ? dateText : <InvisibleSample>{dateText}</InvisibleSample>}</> : null}
          {who ? <>{' · '}{t(off ? 'disconnectedBy' : 'connectedBy', { name: who })}</> : null}
        </p>
      </div>
      {canDisconnect(device) ? (
        // inside a <summary> a button's click would also open/close the row — the button keeps its one meaning
        <Button variant="outline" size="sm" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDisconnect(); }} aria-label={names[0] ? t('disconnectSetupAriaNamed', { device: deviceName, name: names[0], date: date ?? '' }) : t('disconnectSetupAria', { device: deviceName, date: date ?? '' })} data-testid="desktop-device-disconnect">
          {t('disconnect')}
        </Button>
      ) : null}
    </>
  );
  return (
    <li ref={rowRef} data-testid="desktop-device-row" data-state={device.state}>
      {agents.length === 0 ? (
        <div className="flex items-start justify-between gap-3 px-4 py-3">{head}</div>
      ) : (
        <details className="group" open={linked || undefined} data-testid="desktop-device-details">
          <summary
            className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"
            aria-label={date ? t('expandSetupAgentsAria', { device: deviceName, date }) : t('expandAgentsAria', { device: deviceName })}
          >
            {head}
          </summary>
          <ul className="space-y-1 px-4 pb-3 pl-9 text-xs text-muted-foreground" data-testid="desktop-device-agents">
            {agents.map((a) => (
              <li key={a.member_id} className="break-keep" data-testid="desktop-device-agent">
                <Link href={flatHref(`/organization/workforce/${a.member_id}`)} className="font-medium text-foreground hover:underline">{a.name ?? a.member_id}</Link>
                {a.role ? ` · ${stageRoleLabel(a.role, tOrg)}` : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function StateDot({ state }: { state: DesktopDevice['state'] }) {
  if (state === 'disconnected') return null;
  if (state === 'waiting_for_app') return <span aria-hidden className="inline-block size-1.5 rounded-full border border-muted-foreground" />;
  return <span aria-hidden className={`inline-block size-1.5 rounded-full ${state === 'handed_over' ? 'bg-success' : 'bg-muted-foreground'}`} />;
}
