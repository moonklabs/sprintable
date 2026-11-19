'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Chip } from '@/components/ds/chip';
import { ListRow } from '@/components/ds/list-row';
import { fetchWithAuth } from '@/lib/db/client';
import { loadChanges, RETRY_PAUSE_MS, type ChangedFile, type ChangeStatus, type ChangesDeps, type ChangesProblem, type ChangesState } from '@/lib/agent-changes';

/**
 * story 4951 ①c — the «바뀐 파일» sheet of an agent's session: the changed-file list of the session's folder on the computer of the person who paired it.
 * One sheet, one list: a row = the file's name, a second line (what changed in numbers) and a status chip. Names and line counts only — nothing of a file's content
 * is ever on this screen. The list is read when the sheet opens and kept in this component's state: closing and opening again reads again (a new ask), nothing is
 * asked for twice while it is open (the server deletes a list the moment it is read). The words are the strip's own namespace (`chats.agentSession.changes`).
 */
const TONE: Record<ChangeStatus, 'done' | 'failed' | 'neutral' | 'needs-hand'> = {
  added: 'done', untracked: 'done', modified: 'neutral', renamed: 'neutral', typechange: 'neutral', deleted: 'failed', conflicted: 'needs-hand',
};

const PATHS = {
  ask: (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/desktop-changes`,
  look: (agentId: string, commandId: string) => `/api/agents/${encodeURIComponent(agentId)}/desktop-changes/${encodeURIComponent(commandId)}`,
};
const defaultDeps = (): ChangesDeps => ({
  paths: PATHS,
  fetch: (url, init) => fetchWithAuth(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise<boolean>((resolve) => { const id = setTimeout(() => resolve(true), ms); sleepCancels.add(() => { clearTimeout(id); resolve(false); }); }),
});
const sleepCancels = new Set<() => void>();
export const defaultChangesPaths = PATHS;

export function AgentChangesSheet({ agentId, sessionKey, deviceName, filesHref, open, onOpenChange, deps }: {
  agentId: string;
  sessionKey: string;
  deviceName?: string | null;
  /** story 4983 (P5 · PO 11-20): the one line at the bottom — «이 프로젝트 파일 전부 보기» — to the phone app's folder list of THIS computer and agent (nothing to pick when the agent has one project there). Only the phone app passes it (it is the shell that signs). */
  filesHref?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** tests: the network and the clock */
  deps?: ChangesDeps;
}) {
  const t = useTranslations('chats.agentSession.changes');
  // the state belongs to ONE opening: it is tagged with the run that made it, so a closed sheet (or an older run) shows nothing — no state is reset from inside an effect
  const [shown, setShown] = useState<{ run: number; state: ChangesState }>({ run: 0, state: { kind: 'idle' } });
  const [active, setActive] = useState(0); // the run this opening is on — kept as state so the render can compare without reading a ref
  // closing the sheet ends its opening: `active` goes back to 0 in the same render that sees `open` change (the sanctioned «adjust state while rendering»), so the first render of the NEXT
  // opening can never match the old run and show the old list for a moment (codex ①c r1 #2). A guard that does not lean on the Dialog's portal mounting its content a render later
  // (so no test can see the frame it prevents — the mutant that removes it is equivalent in jsdom; the reasoning, not a test, holds it)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) { setWasOpen(open); if (!open) setActive(0); }
  const run = useRef(0);
  const [pressedAt, setPressedAt] = useState(0);
  const [now, setNow] = useState(0);

  const start = useCallback(() => {
    const mine = ++run.current;
    const d = deps ?? defaultDeps();
    setActive(mine);
    setPressedAt(d.now());
    void loadChanges({ agentId, sessionKey }, d, (s) => { if (run.current === mine) setShown({ run: mine, state: s }); }, () => run.current !== mine);
  }, [agentId, sessionKey, deps]);

  // opening the sheet asks; closing it (or changing the session) stops looking — nothing outlives the sheet
  useEffect(() => {
    if (!open) return;
    start();
    const counter = run; // a counter, not a DOM node: the cleanup bumps the CURRENT value on purpose
    return () => { counter.current++; for (const c of sleepCancels) c(); sleepCancels.clear(); };
  }, [open, start]);

  // the server holds two asks of one person 3 s apart: the reload button waits for that pause (a tick moves `now` while it is waiting)
  useEffect(() => {
    if (!open || pressedAt === 0) return;
    const id = setInterval(() => setNow((deps ?? defaultDeps()).now()), 500);
    return () => clearInterval(id);
  }, [open, pressedAt, deps]);

  const state: ChangesState = open && shown.run === active ? shown.state : { kind: 'idle' };
  const busy = state.kind === 'asking' || state.kind === 'waiting';
  const canReload = state.kind === 'problem' ? state.retry : state.kind === 'ready';
  // right after a press the reload button waits out the server's 3 s pause: `now` is the clock the tick below keeps (the render reads no clock itself); before the first tick it is still «just pressed»
  const soon = pressedAt !== 0 && (now === 0 || now - pressedAt < RETRY_PAUSE_MS);

  const files = state.kind === 'ready' ? state.files : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-2xl" data-testid="agent-changes-sheet">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('title')}
            {state.kind === 'ready' && state.total > 0 ? <Chip data-testid="agent-changes-count">{t('count', { count: state.total })}</Chip> : null}
          </DialogTitle>
          <DialogDescription className="break-keep" data-testid="agent-changes-lead">
            {deviceName ? t('lead', { device: deviceName }) : t('leadNoDevice')}
          </DialogDescription>
        </DialogHeader>
        <div className="focus-inset min-h-0 flex-1 overflow-y-auto" data-testid="agent-changes-body">
          {busy ? <p role="status" className="px-4 py-6 text-ds-small text-ds-ink-3" data-testid="agent-changes-loading">{t('loading')}</p> : null}
          {state.kind === 'problem' ? (
            <p role="alert" className="break-keep px-4 py-6 text-ds-body text-ds-ink-2" data-testid="agent-changes-problem" data-problem={state.problem}>{problemText(t, state.problem)}</p>
          ) : null}
          {state.kind === 'ready' && files.length === 0 ? <p className="px-4 py-6 text-ds-body text-ds-ink-2" data-testid="agent-changes-empty">{t('empty')}</p> : null}
          {state.kind === 'ready' && files.length > 0 ? (
            <ul className="m-0 list-none p-0" data-testid="agent-changes-list">
              {files.map((f, i) => <li key={i}><ChangeRow file={f} /></li>)}
            </ul>
          ) : null}
          {state.kind === 'ready' && state.more ? <p className="break-keep px-4 py-3 text-ds-small text-ds-ink-3" data-testid="agent-changes-more">{t('more', { total: state.total })}</p> : null}
          {filesHref ? (
            <div className="px-4 py-3" data-testid="agent-changes-files-line">
              <Button variant="outline" asChild><Link href={filesHref} data-testid="agent-changes-files">{t('allFiles')}</Link></Button>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {canReload ? <Button variant="outline" disabled={busy || soon} onClick={start} data-testid="agent-changes-reload">{t('reload')}</Button> : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type T = ReturnType<typeof useTranslations>;
/** every closed word spelled out with its own literal key (a computed key hides it from the dead-key scan and from a reader grepping for the sentence) */
function problemText(t: T, problem: ChangesProblem): string {
  switch (problem) {
    case 'not_allowed': return t('problem.not_allowed');
    case 'unreachable': return t('problem.unreachable');
    case 'remote_off': return t('problem.remote_off');
    case 'busy': return t('problem.busy');
    case 'too_fast': return t('problem.too_fast');
    case 'session_gone': return t('problem.session_gone');
    case 'expired': return t('problem.expired');
    case 'no_folder': return t('problem.no_folder');
    case 'not_a_repo': return t('problem.not_a_repo');
    case 'not_repo_root': return t('problem.not_repo_root');
    case 'unsafe_repo_config': return t('problem.unsafe_repo_config');
    case 'unsupported_repo': return t('problem.unsupported_repo');
    case 'state_inside': return t('problem.state_inside');
    case 'git_missing': return t('problem.git_missing');
    case 'timeout': return t('problem.timeout');
    case 'upload_failed': return t('problem.upload_failed');
    case 'failed': return t('problem.failed');
  }
}

function statusText(t: T, status: ChangeStatus): string {
  switch (status) {
    case 'added': return t('status.added');
    case 'modified': return t('status.modified');
    case 'deleted': return t('status.deleted');
    case 'renamed': return t('status.renamed');
    case 'untracked': return t('status.untracked');
    case 'conflicted': return t('status.conflicted');
    case 'typechange': return t('status.typechange');
  }
}

function ChangeRow({ file }: { file: ChangedFile }) {
  const t = useTranslations('chats.agentSession.changes');
  const statusChip = <Chip tone={TONE[file.status]} data-testid="agent-changes-status">{statusText(t, file.status)}</Chip>;
  if (file.hidden) {
    return <ListRow title={t('hidden')} subtitle={t('hiddenNote')} trailing={statusChip} data-testid="agent-changes-row" data-hidden="true" />;
  }
  const lines = file.binary ? t('binary') : file.adds !== null && file.dels !== null ? t('lines', { adds: file.adds, dels: file.dels }) : null;
  const name = file.name ?? '';
  const title = file.status === 'renamed' && file.old_name ? t('renamedFrom', { old: file.old_name, name }) : name;
  return <ListRow title={<span title={title} className="[overflow-wrap:anywhere]">{title}</span>} subtitle={lines} trailing={statusChip} data-testid="agent-changes-row" />;
}
