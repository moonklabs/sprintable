'use client';

// story 4983 (P5 · layer 5 · provisional words until the copy list is final) — the phone app's «프로젝트 파일»: pick a computer and one of its projects, then walk its folders. Every folder
// you open is one request the shell seals and the OS prompt confirms; the answer is sealed too — the server holds neither. Nothing here knows a path: a folder is the single names the computer
// listed, and the computer decides which folder of its own a project is. It LISTS and (P6) OPENS one file — its text (secret-looking lines hidden) or a small picture, each one more request the shell seals and the OS prompt
// confirms; saving a file comes later.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { BRIDGE_WAIT_MS } from '@/components/desktop/phone-landing';
import { groupByComputer, readStartable, type StartableComputer } from '@/lib/phone-start';
import { closeWindow, downloadFile, listFolder, openFile, shellTakesFileDownload, shellTakesFileRead, shellTakesFileWindow, shellTakesFiles, type DownloadOutcome, type Ended, type FileEntry, type FilesList, type FilesOutcome, type OpenOutcome } from '@/lib/phone-files';

type Read = { kind: 'reading' } | { kind: 'failed' } | { kind: 'no_phone' } | { kind: 'old_app' } | { kind: 'ready'; computers: StartableComputer[]; remoteOn: boolean; canOpen: boolean; canWindow: boolean; canDownload: boolean };
/** story 4988 (P8): a download of the file on screen — running (`got` of `of` chunks the shell took; 0 of 0 until the first) or ended */
type Download = { kind: 'running'; got: number; of: number } | { kind: 'end'; outcome: DownloadOutcome };
/** story 4987 (P7): the 10-minute window the shell says is open for ONE computer — `msLeft` as of `at` (the screen counts it down; the shell's clocks are the judge, the next answer corrects this one) */
type WindowNow = { setupId: string; msLeft: number; at: number };
type FolderView = { kind: 'folder'; setupId: string; projectId: string; projectName: string; dir: string[]; state: { kind: 'loading' } | { kind: 'list'; list: FilesList } | { kind: 'end'; outcome: Ended } };
/** one file opened from a folder: `back` is the folder as it was (its list is kept, so going back asks nothing) */
type FileView = { kind: 'file'; setupId: string; projectId: string; projectName: string; dir: string[]; name: string; back: FolderView; state: { kind: 'loading' } | { kind: 'shown'; body: Extract<OpenOutcome, { kind: 'text' | 'image' }> } | { kind: 'end'; outcome: Ended } ; dl: Download | null };
type View = { kind: 'choose' } | FolderView | FileView;

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
  const [win, setWin] = useState<WindowNow | null>(null);
  const [clock, setClock] = useState(0); // the screen's «now» for the count-down: set when a window is heard and once a second after (never read from the clock during a render)
  const alive = useRef(true);
  const ask = useRef(0); // one ask counts: a newer one (or leaving) makes an older one draw nothing
  const dlAsk = useRef(0); // story 4988: the same rule for a DOWNLOAD (leaving, a stop or a newer one ends the older one: it drops what the shell and the server hold)
  const dlCleanup = useRef<(() => Promise<void>) | null>(null); // story 4988: ends the download that is running NOW (the shell drops its chunks, the server deletes the request)
  const endDownload = useCallback(() => { dlAsk.current += 1; const c = dlCleanup.current; dlCleanup.current = null; if (c) void c(); }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ask.current += 1; endDownload(); };
  }, [endDownload]);

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
      if (r.kind === 'view') {
        const canOpen = await shellTakesFileRead(phoneCall); // (a shell that only lists keeps listing: the files are not offered)
        const canWindow = await shellTakesFileWindow(phoneCall); // (story 4987: a shell that does not know windows is asked for none — every request is an OS confirmation, as before)
        const canDownload = await shellTakesFileDownload(phoneCall); // (story 4988: a shell that does not know downloads is offered none)
        if (!alive.current || mine !== ask.current) return;
        setRead({ kind: 'ready', computers: groupByComputer(r.view.computers), remoteOn: r.view.remote_control, canOpen, canWindow, canDownload });
      }
      else setRead(r.kind === 'no_phone' || r.kind === 'no_screen_lock' ? { kind: 'no_phone' } : { kind: 'failed' });
    })();
  }, [phoneCall]);
  const readNow = useCallback(() => { setRead({ kind: 'reading' }); load(); }, [load]); // a press (retry): the empty area, then read again
  useEffect(() => { if (inPhoneApp) load(); }, [inPhoneApp, load]);

  // a [닫기] on its way to the shell: the next request waits for it (`window.before`), so it is never made inside the window that was closed
  const closing = useRef<Promise<void>>(Promise.resolve());
  // what the shell says of the window after each request (null = none · it ended): the line on the screen follows it
  const canWindow = read.kind === 'ready' && read.canWindow;
  const windowDeps = useCallback((setupId: string) => ({ ask: canWindow, before: () => closing.current, on: (w: { ms_left: number } | null) => { if (!alive.current || !canWindow) return; if (w) { const at = Date.now(); setClock(at); setWin({ setupId, msLeft: w.ms_left, at }); } else setWin(null); /* (the shell's word on a request: none — what the screen showed of a window is not drawn until the next request says it again) */ } }), [canWindow]);
  useEffect(() => {
    if (!win) return;
    // the timer runs while a window is heard and stops at its end (the line is drawn only while there is time left: the end needs no state of its own)
    const timer = setInterval(() => { const n = Date.now(); setClock(n); if (n - win.at >= win.msLeft) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [win]);
  const msLeft = win ? win.msLeft - (clock - win.at) : 0;
  const closeNow = useCallback(() => { if (!win) return; const id = win.setupId; setWin(null); closing.current = closeWindow(id, phoneCall); }, [win, phoneCall]);

  const open = useCallback((setupId: string, projectId: string, projectName: string, dir: string[], cursor?: string, keep?: FileEntry[]) => {
    const mine = ++ask.current;
    if (cursor === undefined) setView({ kind: 'folder', setupId, projectId, projectName, dir, state: { kind: 'loading' } });
    else setView((v) => (v.kind === 'folder' ? { ...v, state: { kind: 'loading' } } : v));
    void listFolder({ setupId, projectId, dir, ...(cursor !== undefined ? { cursor } : {}) }, { phoneCall, newKey, stopped: () => !alive.current || mine !== ask.current, window: windowDeps(setupId) }).then((out) => {
      if (!alive.current || mine !== ask.current) return;
      setView((v) => {
        if (v.kind !== 'folder' || v.setupId !== setupId || v.projectId !== projectId) return v;
        if (out.kind === 'list') return { ...v, dir, state: { kind: 'list', list: keep ? { ...out.list, entries: [...keep, ...out.list.entries] } : out.list } };
        return { ...v, dir, state: { kind: 'end', outcome: out } };
      });
    });
  }, [phoneCall, windowDeps]);

  // one file: asked from the folder that holds it (its list stays in memory behind it)
  const openOne = useCallback((from: FolderView, name: string) => {
    const mine = ++ask.current;
    setView({ kind: 'file', setupId: from.setupId, projectId: from.projectId, projectName: from.projectName, dir: from.dir, name, back: from, state: { kind: 'loading' }, dl: null });
    void openFile({ setupId: from.setupId, projectId: from.projectId, dir: from.dir, name }, { phoneCall, newKey, stopped: () => !alive.current || mine !== ask.current, window: windowDeps(from.setupId) }).then((out) => {
      if (!alive.current || mine !== ask.current) return;
      setView((v) => {
        if (v.kind !== 'file' || v.name !== name || v.setupId !== from.setupId || v.projectId !== from.projectId) return v;
        return { ...v, state: out.kind === 'text' || out.kind === 'image' ? { kind: 'shown', body: out } : { kind: 'end', outcome: out } };
      });
    });
  }, [phoneCall, windowDeps]);

  // story 4988 (P8): download the file on screen — one more request the shell seals and the OS prompt confirms (every time: a window never covers it); the chunks go through the shell, which hands the whole file to the share sheet
  const download = useCallback((v: FileView) => {
    const mine = ++dlAsk.current;
    const put = (dl: Download | null) => setView((cur) => (cur.kind === 'file' && cur.name === v.name && cur.setupId === v.setupId && cur.projectId === v.projectId ? { ...cur, dl } : cur));
    put({ kind: 'running', got: 0, of: 0 });
    void downloadFile({ setupId: v.setupId, projectId: v.projectId, dir: v.dir, name: v.name }, {
      phoneCall, newKey, stopped: () => !alive.current || mine !== dlAsk.current,
      onProgress: (p) => put({ kind: 'running', got: p.got, of: p.of }), // (the road calls this only while this download is the current one: its own `stopped` says so)
      onCleanup: (c) => { if (mine === dlAsk.current) dlCleanup.current = c; },
    }).then((outcome) => { // (`downloadFile` never rejects: a refused bridge call ends it as `failed`)
      if (!alive.current || mine !== dlAsk.current) return;
      put({ kind: 'end', outcome });
    });
  }, [phoneCall]);
  const stopDownload = useCallback((v: FileView) => { endDownload(); setView((cur) => (cur.kind === 'file' && cur.name === v.name ? { ...cur, dl: null } : cur)); }, [endDownload]);

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
        {win && msLeft > 0 && view.kind !== 'choose' && win.setupId === view.setupId ? <WindowLine t={t} msLeft={msLeft} onClose={closeNow} /> : null}
        {view.kind === 'file'
          ? <FileScreen t={t} v={view} canDownload={read.kind === 'ready' && read.canDownload} onDownload={() => download(view)} onStopDownload={() => stopDownload(view)} onRetry={() => openOne(view.back, view.name)} onBack={() => { endDownload(); open(view.back.setupId, view.back.projectId, view.back.projectName, view.back.dir); }} />
          : view.kind === 'folder'
          ? <Folder t={t} v={view} canOpen={read.kind === 'ready' && read.canOpen} onOpen={open} onFile={(name) => openOne(view, name)} onBack={() => { ask.current += 1; setView({ kind: 'choose' }); }} />
          : <Choose t={t} read={read} only={from} onReload={readNow} onPick={(setupId, project) => open(setupId, project.project_id, project.name, [])} />}
        {view.kind === 'choose' && (
          <div className="border-t border-border pt-4">
            <Button variant="ghost" onClick={() => { endDownload(); window.location.replace(homeHref); }} data-testid="phone-files-home">{t('home')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

/** story 4987 (P7): «10분 동안 다시 묻지 않음 · 남은 시간 mm:ss · [닫기]» — shown while the shell says a window is open; [닫기] makes the next request an OS confirmation again */
function WindowLine({ t, msLeft, onClose }: { t: T; msLeft: number; onClose: () => void }) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground" data-testid="phone-files-window">
      <span>{t('window.on', { time })}</span>
      <Button variant="outline" size="sm" onClick={onClose} data-testid="phone-files-window-close">{t('window.close')}</Button>
    </div>
  );
}

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

/** what an end of an OPEN says — the closed words of the contract, said for one file */
function fileEndLine(t: T, o: Ended): string {
  if (o.kind === 'reason') return t(`fileReason.${o.reason}`);
  return endLine(t, o);
}

/** story 4988 (P8): what a download says — «받는 중 3/57» while it runs, one line when it ended (saved, or why not) */
function DownloadLine({ t, dl, onStop, onRetry }: { t: T; dl: Download; onStop: () => void; onRetry: () => void }) {
  if (dl.kind === 'running') {
    return (
      <div role="status" className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground" data-testid="phone-files-download-running">
        <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />{dl.of > 0 ? t('download.running', { got: dl.got, of: dl.of }) : t('download.starting')}</span>
        <Button variant="outline" size="sm" onClick={onStop} data-testid="phone-files-download-stop">{t('download.stop')}</Button>
      </div>
    );
  }
  const o = dl.outcome;
  if (o.kind === 'saved') return <p role="status" className="text-sm text-foreground" data-testid="phone-files-download-saved">{t('download.saved')}</p>;
  const line = o.kind === 'incomplete' ? t('download.reason.incomplete') : o.kind === 'save_failed' ? t('download.saveFailed') : o.kind === 'reason' ? t(`download.reason.${o.reason}`) : o.kind === 'cancelled' ? t('outcome.cancelled') : endLine(t, o);
  const again = o.kind === 'incomplete' || o.kind === 'save_failed' || o.kind === 'cancelled' || (o.kind === 'reason' ? o.reason === 'busy' || o.reason === 'timeout' || o.reason === 'changed_while_reading' : retryable(o));
  return <Line t={t} text={line} testId="phone-files-download-end" onRetry={again ? onRetry : undefined} />;
}

function FileScreen({ t, v, canDownload, onDownload, onStopDownload, onRetry, onBack }: { t: T; v: FileView; canDownload: boolean; onDownload: () => void; onStopDownload: () => void; onRetry: () => void; onBack: () => void }) {
  const crumbs = [v.projectName, ...v.dir, v.name].join(' › ');
  return (
    <div className="space-y-3" data-testid="phone-files-open">
      <p className="break-all text-sm text-muted-foreground" data-testid="phone-files-crumbs">{crumbs}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onBack} data-testid="phone-files-file-back">{t('file.back')}</Button>
        {canDownload && v.state.kind === 'shown' && v.dl === null && <Button variant="outline" size="sm" onClick={onDownload} data-testid="phone-files-download">{t('download.button')}</Button>}
      </div>
      {v.dl && <DownloadLine t={t} dl={v.dl} onStop={onStopDownload} onRetry={onDownload} />}
      {v.state.kind === 'loading' && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="phone-files-file-loading">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('file.loading')}
        </div>
      )}
      {v.state.kind === 'end' && v.dl === null && <Line t={t} text={v.state.outcome.kind === 'cancelled' ? t('outcome.cancelled') : fileEndLine(t, v.state.outcome)} testId="phone-files-file-end" onRetry={v.state.outcome.kind === 'cancelled' || retryable(v.state.outcome) ? onRetry : undefined} />}
      {canDownload && v.dl === null && v.state.kind === 'end' && v.state.outcome.kind === 'reason' && (v.state.outcome.reason === 'too_big' || v.state.outcome.reason === 'not_text') && <div><Button variant="outline" onClick={onDownload} data-testid="phone-files-download-instead">{t('download.button')}</Button></div>}
      {v.state.kind === 'shown' && v.state.body.kind === 'text' && (
        <div className="space-y-2">
          {v.state.body.masked > 0 && <p role="status" className="text-xs text-muted-foreground" data-testid="phone-files-file-masked">{t('file.masked', { count: v.state.body.masked })}</p>}
          {v.state.body.text === ''
            ? <p className="text-sm text-muted-foreground" data-testid="phone-files-file-empty">{t('file.empty')}</p>
            : <Card className="p-3"><pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words text-xs text-foreground" data-testid="phone-files-file-text">{v.state.body.text}</pre></Card>}
        </div>
      )}
      {v.state.kind === 'shown' && v.state.body.kind === 'image' && (
        // eslint-disable-next-line @next/next/no-img-element -- story 4983 P6: bytes the person's own computer sent (type and size checked), shown as a data: URL — nothing to optimise and no host to allow
        <img src={`data:${v.state.body.mime};base64,${v.state.body.data}`} alt={t('file.imageAlt', { name: v.name })} width={v.state.body.w} height={v.state.body.h} className="h-auto max-w-full rounded-md" data-testid="phone-files-file-image" />
      )}
    </div>
  );
}

function Folder({ t, v, canOpen, onOpen, onFile, onBack }: { t: T; v: FolderView; canOpen: boolean; onFile: (name: string) => void; onOpen: (setupId: string, projectId: string, projectName: string, dir: string[], cursor?: string, keep?: FileEntry[]) => void; onBack: () => void }) {
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
      {v.state.kind === 'list' && <List t={t} list={v.state.list} canOpen={canOpen} onFile={onFile} onFolder={(n) => here([...v.dir, n])} onMore={() => here(v.dir, v.state.kind === 'list' ? v.state.list.cursor : undefined, v.state.kind === 'list' ? v.state.list.entries : undefined)} />}
    </div>
  );
}

/** an end the person may try again at once (a changed setting or a missing pairing needs something else first) */
function retryable(o: Exclude<FilesOutcome, { kind: 'list' }>): boolean {
  return o.kind === 'busy' || o.kind === 'timeout' || o.kind === 'failed' || o.kind === 'unreachable' || (o.kind === 'reason' && (o.reason === 'busy' || o.reason === 'timeout' || o.reason === 'changed_while_reading'));
}

function List({ t, list, canOpen, onFile, onFolder, onMore }: { t: T; list: FilesList; canOpen: boolean; onFile: (name: string) => void; onFolder: (name: string) => void; onMore: () => void }) {
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
            ) : e.k === 'f' && canOpen ? (
              <Button variant="ghost" className="h-auto w-full justify-between gap-2 px-0 py-0 text-left font-normal" onClick={() => onFile(e.n)} aria-label={t('file.openFile', { name: e.n })} data-testid="phone-files-file">
                <span className="break-all text-sm text-foreground">{e.n}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{e.s !== undefined ? sizeText(e.s) : ''}</span>
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
