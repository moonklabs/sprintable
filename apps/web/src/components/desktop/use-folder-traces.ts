'use client';
// [SID:4693] (UX-1 · D4) — what the desktop app says about a folder: does it carry CLAUDE.md / AGENTS.md, and which of this project's agents
// already work in it on this computer. The app answers only about a folder IT knows (the project's kept folder · one this page picked through
// the app's own chooser) — the page never names a path itself. `null` = not asked or not answered yet; in a browser, in an older app (no hand)
// or when the answer is refused it is never anything but «nothing there» (lib/desktop-app readFolderTraces).
import { useEffect, useState } from 'react';
import { readFolderTraces, type FolderTracesAnswer, type SprintableDesktop } from '@/lib/desktop-app';

export type FolderTraceSource = { projectId: string } | { path: string };

/** `ask` = the bridge's `folderTraces` (undefined → never asks) · `source` null → not asked · `agentIds` null → wait until the project's agents are known
 *  (the answer is the intersection with them, so asking earlier would answer less) */
export function useFolderTraces(ask: SprintableDesktop['folderTraces'], source: FolderTraceSource | null, agentIds: readonly string[] | null): FolderTracesAnswer | null {
  const sourceKey = source ? ('projectId' in source ? `p:${source.projectId}` : `f:${source.path}`) : '';
  const idsKey = agentIds ? agentIds.join('\n') : null;
  const asked = `${sourceKey}|${idsKey}`;
  const [state, setState] = useState<{ asked: string; answer: FolderTracesAnswer } | null>(null);
  useEffect(() => {
    if (typeof ask !== 'function' || !source || agentIds === null) return;
    let live = true;
    void readFolderTraces(ask, { ...source, agentIds }).then((answer) => { if (live) setState({ asked, answer }); });
    return () => { live = false; };
    // the folder and the ids asked about are what matter — a new `source` / `agentIds` object with the same content is not a new question
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, asked]);
  return typeof ask === 'function' && source && agentIds !== null && state?.asked === asked ? state.answer : null;
}
