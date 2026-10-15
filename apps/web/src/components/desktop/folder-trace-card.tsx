'use client';
// [SID:4693] (UX-1 · D4 · Yuna copy `yuna/4693-copy.md` ①②③) — the recruiter's top card inside the desktop app.
//  ① the project's folder carries a CLAUDE.md / AGENTS.md → «이 프로젝트 폴더에 {file} 파일이 있어요» + [이 폴더의 에이전트로 채용] (the first
//    choice: it skips choosing a role — the page below stays as it is);
//  ③ an agent of this project already works in that folder on this computer → «이 컴퓨터에서 이 프로젝트 폴더로 일하는 에이전트가 있어요» and one
//    row per agent with [이 컴퓨터에서 시작] (replaces ① — never a second agent for the same folder).
// The app only knows that a file exists (never what is in it) and which profiles on THIS computer have this folder — so the words say «이 컴퓨터에서»
// and no more. Nothing is drawn when there is nothing to say (the caller passes neither a trace nor an agent).
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { FolderTrace } from '@/lib/desktop-app';

export interface FolderTraceCardProps {
  /** the file the card names (the one whose runtime the app found first — `pickFolderTrace`) */
  trace: FolderTrace | undefined;
  /** the display name of that file's runtime (`runtimeDisplayName` of its capability) */
  runtimeName: string;
  /** this project's agents that have a profile in the folder on this computer (names resolved by the page) */
  agents: readonly { id: string; name: string }[];
  /** ② [이 폴더의 에이전트로 채용] */
  onRecruit: () => void;
  /** ③ [이 컴퓨터에서 시작] for one agent — the bridge's `startHere` */
  onStart: (agentId: string) => Promise<{ ok: true } | { ok: false; code: string }>;
}

type RowState = 'idle' | 'busy' | 'ok' | 'failed';

export function FolderTraceCard({ trace, runtimeName, agents, onRecruit, onStart }: FolderTraceCardProps) {
  const t = useTranslations('recruiter');
  const tc = useTranslations('common');
  const titleId = useId();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  if (agents.length === 0 && !trace) return null;

  const start = async (id: string) => {
    if (rows[id] === 'busy') return;
    setRows((r) => ({ ...r, [id]: 'busy' }));
    let ok = false;
    try { ok = (await onStart(id)).ok; } catch { ok = false; }
    setRows((r) => ({ ...r, [id]: ok ? 'ok' : 'failed' }));
  };

  if (agents.length > 0) {
    return (
      <section aria-labelledby={titleId} className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3" data-testid="folder-agent-card">
        <p id={titleId} className="text-sm font-medium break-keep">{t('folderAgentTitle')}</p>
        <p className="text-xs text-muted-foreground break-keep">{t('folderAgentBody')}</p>
        <ul className="space-y-2">
          {agents.map((a) => (
            <li key={a.id} className="space-y-1" data-testid="folder-agent-row">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium" title={a.name || undefined}>{a.name || tc('agentUnnamed')}</span>
                {/* Yuna 4693 (#3592 guard): the same visible label on every row — the aria-label says WHICH agent this starts (the name, not an index: the name is on the row) */}
                <Button type="button" size="sm" variant={agents.length === 1 ? 'hero' : 'outline'} className="shrink-0 whitespace-nowrap" disabled={rows[a.id] === 'busy'} aria-label={t('folderAgentStartAria', { name: a.name || tc('agentUnnamed') })} onClick={() => void start(a.id)} data-testid="folder-agent-start">
                  {t('startHere')}
                </Button>
              </div>
              {rows[a.id] === 'ok' ? <p role="status" aria-live="polite" className="text-xs text-foreground" data-testid="folder-agent-opened">{t('startHereOpened')}</p> : null}
              {rows[a.id] === 'failed' ? <p role="alert" aria-live="assertive" className="text-xs text-foreground" data-testid="folder-agent-failed">{t('startHereFailed')}</p> : null}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3" data-testid="folder-trace-card">
      <p id={titleId} className="text-sm font-medium break-keep">{t('folderTraceTitle', { file: trace!.file })}</p>
      <p className="text-xs text-muted-foreground break-keep">{t('folderTraceBody', { runtime: runtimeName, file: trace!.file })}</p>
      <Button type="button" variant="hero" className="whitespace-nowrap" onClick={onRecruit} data-testid="folder-trace-recruit">
        {t('folderTraceRecruit')}
      </Button>
    </section>
  );
}
