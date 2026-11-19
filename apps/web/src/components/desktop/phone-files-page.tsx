'use client';

// story 4983 (P5 · layer 5 · provisional words until the copy list is final) — the phone app's «프로젝트 파일»: pick a computer and one of its projects, then walk its folders. Every folder
// you open is one request the shell seals and the OS prompt confirms; the answer is sealed too — the server holds neither. Nothing here knows a path: a folder is the single names the computer
// listed, and the computer decides which folder of its own a project is. This slice LISTS; opening a file and saving one come later.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { BRIDGE_WAIT_MS } from '@/components/desktop/phone-landing';
import { groupByComputer, readStartable, type StartableComputer } from '@/lib/phone-start';
import { listFolder, shellTakesFiles, type FileEntry, type FilesList, type FilesOutcome } from '@/lib/phone-files';

type Read = { kind: 'reading' } | { kind: 'failed' } | { kind: 'no_phone' } | { kind: 'old_app' } | { kind: 'ready'; computers: StartableComputer[]; remoteOn: boolean };
type View =
  | { kind: 'choose' }
  | { kind: 'folder'; setupId: string; projectId: string; projectName: string; dir: string[]; state: { kind: 'loading' } | { kind: 'list'; list: FilesList } | { kind: 'end'; outcome: Exclude<FilesOutcome, { kind: 'list' }> } };

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

/** the projects of one computer that have a folder on it: those of the agents it lists (a project once, whichever agent works in it) */
export function projectsOf(c: StartableComputer): Array<{ project_id: string; name: string }> {
  const seen = new Map<string, { project_id: string; name: string }>();
  for (const a of c.agents) for (const p of a.projects) if (!seen.has(p.project_id)) seen.set(p.project_id, p);
  return [...seen.values()];
}

/** bytes as the screen says them: 0 B · 1.2 KB · 3 MB (whole numbers from 10) */
export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

/** where the person stood when they came (the «바뀐 파일» sheet's line): the computer and the agent whose session they were looking at — the screen opens that agent's project on that computer */
export interface FilesEntry { setupId: string; agentId: string }

/**
 * The entry's computer and project(s): the agent's own projects on the computer it stands on. `setupId` is the one the shell and the computer know the agent by (a computer of several setups lists each agent under its
 * own). null when the list has no such agent there (the screen then shows its ordinary choice).
 */
export function entryOf(computers: StartableComputer[], entry: FilesEntry): { computer: StartableComputer; setupId: string; projects: Array<{ project_id: string; name: string }> } | null {
  for (const c of computers) {
    const a = c.agents.find((x) => x.agent_member_id === entry.agentId && (x.setup_id ?? c.setup_id) === entry.setupId);
    if (a && a.projects.length > 0) return { computer: c, setupId: entry.setupId, projects: a.projects };
  }
  return null;
}

export function PhoneFilesPage({ homeHref, entry }: { homeHref: string; entry?: FilesEntry }) {
  const t = useTranslations('phoneFiles');
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  const [view, setView] = useState<View>({ kind: 'choose' });
  const alive = useRef(true);
  const ask = useRef(0); // one ask counts: a newer one (or leaving) makes an older one draw nothing
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ask.current += 1; };
  }, []);

  // this screen is the phone app's: anywhere else (a browser that opened the address) it goes home after the claim had its moment
  useEffect(() => {
    if (inPhoneApp) return;
    const timer = setTimeout(() => window.location.replace(homeHref), BRIDGE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [inPhoneApp, homeHref]);

  // the read itself (the first one is drawn as «reading» already — no state is set synchronously in the effect that starts it)
  const load = useCallback(() => {
    const mine = ++ask.current;
    void (async () => {
      const takes = await shellTakesFiles(phoneCall);
      if (!alive.current || mine !== ask.current) return;
      if (!takes) { setRead({ kind: 'old_app' }); return; }
      const r = await readStartable(phoneCall, () => !alive.current || mine !== ask.current).catch(() => ({ kind: 'failed' as const }));
      if (!alive.current || mine !== ask.current) return;
      if (r.kind === 'view') setRead({ kind: 'ready', computers: groupByComputer(r.view.computers), remoteOn: r.view.remote_control });
      else setRead(r.kind === 'no_phone' || r.kind === 'no_screen_lock' ? { kind: 'no_phone' } : { kind: 'failed' });
    })();
  }, [phoneCall]);
  const readNow = useCallback(() => { setRead({ kind: 'reading' }); load(); }, [load]); // a press (retry): the empty area, then read again
  useEffect(() => { if (inPhoneApp) load(); }, [inPhoneApp, load]);

  const open = useCallback((setupId: string, projectId: string, projectName: string, dir: string[], cursor?: string, keep?: FileEntry[]) => {
    const mine = ++ask.current;
    if (cursor === undefined) setView({ kind: 'folder', setupId, projectId, projectName, dir, state: { kind: 'loading' } });
    else setView((v) => (v.kind === 'folder' ? { ...v, state: { kind: 'loading' } } : v));
    void listFolder({ setupId, projectId, dir, ...(cursor !== undefined ? { cursor } : {}) }, { phoneCall, newKey, stopped: () => !alive.current || mine !== ask.current }).then((out) => {
      if (!alive.current || mine !== ask.current) return;
      setView((v) => {
        if (v.kind !== 'folder' || v.setupId !== setupId || v.projectId !== projectId) return v;
        if (out.kind === 'list') return { ...v, dir, state: { kind: 'list', list: keep ? { ...out.list, entries: [...keep, ...out.list.entries] } : out.list } };
        return { ...v, dir, state: { kind: 'end', outcome: out } };
      });
    });
  }, [phoneCall]);

  // came from the session: the agent has ONE project on that computer → open its top at once (the one thing the person asked for); several → the choice among THOSE projects; none → the ordinary choice
  const entered = useRef(false);
  const from = read.kind === 'ready' && entry ? entryOf(read.computers, entry) : null;
  useEffect(() => {
    // remote control off: the screen says so and asks nothing (the entry never prompts where the ordinary screen would refuse)
    if (entered.current || !from || read.kind !== 'ready' || !read.remoteOn || from.projects.length !== 1 || !from.computer.reachable) return;
    entered.current = true;
    const p = from.projects[0]!;
    void Promise.resolve().then(() => { if (alive.current) open(from.setupId, p.project_id, p.name, []); }); // (asked after this render, not set from inside the effect)
  }, [from, open, read]);

  if (!inPhoneApp) return <div className="min-h-screen bg-background" aria-busy="true" data-testid="phone-files-wait" />;
  return (
    <div className="flex min-h-screen justify-center bg-background px-4 py-6">
      <div className="w-full max-w-md space-y-4" data-testid="phone-files-page">
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        {view.kind === 'folder'
          ? <Folder t={t} v={view} onOpen={open} onBack={() => { ask.current += 1; setView({ kind: 'choose' }); }} />
          : <Choose t={t} read={read} only={from} onReload={readNow} onPick={(setupId, project) => open(setupId, project.project_id, project.name, [])} />}
        <div className="border-t border-border pt-4">
          <Button variant="ghost" onClick={() => window.location.replace(homeHref)} data-testid="phone-files-home">{t('home')}</Button>
        </div>
      </div>
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

function Choose({ t, read, only, onReload, onPick }: { t: T; read: Read; only: ReturnType<typeof entryOf>; onReload: () => void; onPick: (setupId: string, project: { project_id: string; name: string }) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const computers = useMemo(() => (read.kind === 'ready' ? read.computers.filter((c) => projectsOf(c).length > 0) : []), [read]);
  if (read.kind === 'reading') return <div aria-busy="true" data-testid="phone-files-reading"><Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /></div>;
  if (read.kind === 'old_app') return <Card className="break-keep p-4" data-testid="phone-files-old-app"><p className="text-sm text-foreground">{t('oldApp')}</p></Card>;
  if (read.kind === 'failed') return <Line t={t} text={t('readFailed')} testId="phone-files-read-failed" onRetry={onReload} />;
  if (read.kind === 'no_phone') return <Card className="break-keep p-4" data-testid="phone-files-no-mac"><p className="text-sm text-foreground">{t('noMac')}</p></Card>;
  if (!read.remoteOn) return <Card className="break-keep p-4" data-testid="phone-files-remote-off"><p className="text-sm text-foreground">{t('remoteOff')}</p></Card>;
  if (computers.length === 0) return <Card className="break-keep p-4" data-testid="phone-files-no-project"><p className="text-sm text-foreground">{t('noProjectOnMac')}</p></Card>;
  // came from a session: only THAT agent's projects on THAT computer (no Mac to choose); the computer's own reachability decides as ever
  if (only) {
    return (
      <div className="space-y-3" data-testid="phone-files-choose">
        {!only.computer.reachable && <p role="status" className="text-sm text-muted-foreground" data-testid="phone-files-unreachable">{t('outcome.unreachable')}</p>}
        <p className="text-sm text-muted-foreground">{t('chooseProject', { device: only.computer.device_name })}</p>
        <ul className="space-y-1">
          {only.projects.map((p) => (
            <li key={p.project_id}>
              <Button variant="outline" className="w-full justify-start" disabled={!only.computer.reachable} onClick={() => onPick(only.setupId, p)} data-testid={`phone-files-project-${p.project_id}`}>{p.name}</Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const computer = computers.find((c) => c.setup_id === picked) ?? computers.find((c) => c.reachable) ?? computers[0]!;
  return (
    <div className="space-y-3" data-testid="phone-files-choose">
      {computers.length > 1 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('chooseComputer')}>
          {computers.map((c) => (
            <li key={c.setup_id}>
              <Button variant={c.setup_id === computer.setup_id ? 'default' : 'outline'} size="sm" onClick={() => setPicked(c.setup_id)} data-testid={`phone-files-computer-${c.setup_id}`}>{c.device_name}</Button>
            </li>
          ))}
        </ul>
      )}
      {!computer.reachable && <p role="status" className="text-sm text-muted-foreground" data-testid="phone-files-unreachable">{t('outcome.unreachable')}</p>}
      <p className="text-sm text-muted-foreground">{t('chooseProject', { device: computer.device_name })}</p>
      <ul className="space-y-1">
        {projectsOf(computer).map((p) => (
          <li key={p.project_id}>
            <Button variant="outline" className="w-full justify-start" disabled={!computer.reachable} onClick={() => onPick(computer.setup_id, p)} data-testid={`phone-files-project-${p.project_id}`}>{p.name}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Line({ t, text, testId, onRetry }: { t: T; text: string; testId: string; onRetry?: () => void }) {
  return (
    <Card className="break-keep flex flex-col gap-3 p-4" data-testid={testId}>
      <p role="alert" className="text-sm text-foreground">{text}</p>
      {onRetry && <div><Button variant="outline" onClick={onRetry}>{t('retry')}</Button></div>}
    </Card>
  );
}

/** what an end that is not a list says — one line per closed word (the computer's refusal words are `reason.*`) */
function endLine(t: T, o: Exclude<FilesOutcome, { kind: 'list' }>): string {
  if (o.kind === 'reason') return t(`reason.${o.reason}`);
  if (o.kind === 'key') return t(`key.${o.code}`);
  return t(`outcome.${o.kind}`);
}

function Folder({ t, v, onOpen, onBack }: { t: T; v: Extract<View, { kind: 'folder' }>; onOpen: (setupId: string, projectId: string, projectName: string, dir: string[], cursor?: string, keep?: FileEntry[]) => void; onBack: () => void }) {
  const here = (dir: string[], cursor?: string, keep?: FileEntry[]) => onOpen(v.setupId, v.projectId, v.projectName, dir, cursor, keep);
  const crumbs = [v.projectName, ...v.dir].join(' › ');
  return (
    <div className="space-y-3" data-testid="phone-files-folder">
      <p className="break-all text-sm text-muted-foreground" data-testid="phone-files-crumbs">{crumbs}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onBack} data-testid="phone-files-back">{t('back')}</Button>
        {v.dir.length > 0 && <Button variant="outline" size="sm" onClick={() => here(v.dir.slice(0, -1))} data-testid="phone-files-up">{t('up')}</Button>}
      </div>
      {v.state.kind === 'loading' && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="phone-files-loading">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('loading')}
        </div>
      )}
      {v.state.kind === 'end' && (v.state.outcome.kind === 'cancelled'
        ? <Line t={t} text={t('outcome.cancelled')} testId="phone-files-end" onRetry={() => here(v.dir)} />
        : <Line t={t} text={endLine(t, v.state.outcome)} testId="phone-files-end" onRetry={retryable(v.state.outcome) ? () => here(v.dir) : undefined} />)}
      {v.state.kind === 'list' && <List t={t} list={v.state.list} onFolder={(n) => here([...v.dir, n])} onMore={() => here(v.dir, v.state.kind === 'list' ? v.state.list.cursor : undefined, v.state.kind === 'list' ? v.state.list.entries : undefined)} />}
    </div>
  );
}

/** an end the person may try again at once (a changed setting or a missing pairing needs something else first) */
function retryable(o: Exclude<FilesOutcome, { kind: 'list' }>): boolean {
  return o.kind === 'busy' || o.kind === 'timeout' || o.kind === 'failed' || o.kind === 'unreachable' || (o.kind === 'reason' && (o.reason === 'busy' || o.reason === 'timeout' || o.reason === 'changed_while_reading'));
}

function List({ t, list, onFolder, onMore }: { t: T; list: FilesList; onFolder: (name: string) => void; onMore: () => void }) {
  return (
    <div className="space-y-2" data-testid="phone-files-list">
      {list.entries.length === 0 && <p className="text-sm text-muted-foreground" data-testid="phone-files-empty">{t('empty')}</p>}
      <Card className="p-0">
      <ul className="divide-y divide-border">
        {list.entries.map((e) => (
          <li key={`${e.k}:${e.n}`} className="px-3 py-2" data-testid="phone-files-entry">
            {e.k === 'd' ? (
              <Button variant="ghost" className="h-auto w-full justify-start px-0 py-0 text-left font-medium" onClick={() => onFolder(e.n)} aria-label={t('openFolder', { name: e.n })}>
                <span className="break-all">{e.n}</span><span aria-hidden className="ml-1 text-muted-foreground">/</span>
              </Button>
            ) : (
              <div className="flex items-baseline justify-between gap-2">
                <span className="break-all text-sm text-foreground">{e.n}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{e.k === 'l' ? t('kind.link') : e.k === 'o' ? t('kind.other') : e.s !== undefined ? sizeText(e.s) : ''}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
      </Card>
      {list.hidden > 0 && <p className="text-xs text-muted-foreground" data-testid="phone-files-hidden">{t('hidden', { count: list.hidden })}</p>}
      {list.more && list.cursor !== undefined && <Button variant="outline" onClick={onMore} data-testid="phone-files-more">{t('more')}</Button>}
    </div>
  );
}
