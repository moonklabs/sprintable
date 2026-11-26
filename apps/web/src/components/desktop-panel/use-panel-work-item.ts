'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { isPanelId } from './panel-path';

/**
 * story 5042 (C9) — the desktop app's work-item tab: «the one story this agent is working on now». The server already knows it (`active_story_id` on the agent's member row); the page reads it again every
 * POLL_MS (the agent moves on to the next story) and on a retry. A read that fails is an ERROR with a retry — never «no work item» (that is the server's own answer: the field is empty).
 * A late answer of an older read is dropped (the id in the address changed, or the page went away).
 */
export type PanelWorkItem =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'none' }
  | { phase: 'story'; storyId: string };

export const POLL_MS = 15_000;

/** `GET /api/team-members/{id}` → the id of the story the agent works on (null = none; undefined = the answer is not a member row) */
export function activeStoryIdOf(json: unknown): string | null | undefined {
  const root = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as { data?: unknown }) : null;
  const row = root && typeof root.data === 'object' && root.data !== null && !Array.isArray(root.data) ? (root.data as { active_story_id?: unknown }) : null;
  if (!row) return undefined;
  if (row.active_story_id === null || row.active_story_id === undefined) return null;
  return isPanelId(row.active_story_id) ? row.active_story_id : undefined;
}

async function readJson(url: string): Promise<{ ok: boolean; json: unknown }> {
  try {
    const res = await fetchWithAuth(url);
    return { ok: res.ok, json: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return { ok: false, json: null };
  }
}

export function usePanelWorkItem(agentId: string): PanelWorkItem & { retry: () => void } {
  const [state, setState] = useState<PanelWorkItem>({ phase: 'loading' });
  const seq = useRef(0);

  const read = useCallback(async () => {
    const mine = ++seq.current;
    const res = await readJson(`/api/team-members/${agentId}`);
    if (mine !== seq.current) return; // an older read, or the page is gone
    const id = res.ok ? activeStoryIdOf(res.json) : undefined;
    // a failed read after a good one keeps what is shown (the next poll tries again); only a page with nothing to show says «error»
    setState((prev) => (id === undefined ? (prev.phase === 'story' || prev.phase === 'none' ? prev : { phase: 'error' }) : id === null ? { phase: 'none' } : prev.phase === 'story' && prev.storyId === id ? prev : { phase: 'story', storyId: id }));
  }, [agentId]);

  // (a new agent id is a new page: the component is keyed by it — see WorkItemPanel — so the state starts at «loading» without a reset here)
  useEffect(() => {
    if (!isPanelId(agentId)) return; // an address that is not a uuid is never read (the page says so itself)
    let gone = false; // the page may be gone before the first read's turn comes (codex): a read queued by a page that is gone is never started
    queueMicrotask(() => { if (!gone) void read(); }); // (the first read starts right after the effect — never a state change inside the effect body)
    const timer = setInterval(() => { void read(); }, POLL_MS);
    return () => { gone = true; seq.current += 1; clearInterval(timer); };
  }, [agentId, read]);

  const retry = useCallback(() => { if (!isPanelId(agentId)) return; setState({ phase: 'loading' }); void read(); }, [agentId, read]);
  return { ...state, retry };
}
