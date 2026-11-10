'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { EMPTY_TODAY_SNAPSHOT, parseToday, type TodayCompletedItem, type TodaySnapshot } from '@/components/org-briefing/derive-today';
import {
  deriveHome,
  type HomeDoneInput,
  type HomeModel,
  type HomeNotificationInput,
  type HomeStoryInput,
} from './derive-home';

/**
 * story #4888 (UI-5 AC4, home) — the ONE place the home's data is read and `deriveHome` is run. The navigation bar's «홈» badge and the home screen both read this model, so
 * the number on the bar is the number of rows in «내 손이 필요해요» by construction (a test fails when they are given different sources).
 *
 * No new route: the snapshot is `GET /api/today` (the same single call the old screen made), unread notifications are `GET /api/notifications?unread=true` (the bell's list), and the
 * person's in-progress stories are `GET /api/stories?status=in-progress` of the current project with `GET /api/members` for who is an agent.
 * It re-reads every `POLL_MS` and when the tab comes back, so the bar does not keep a stale number.
 */

export const HOME_POLL_MS = 60_000;

export interface HomeSources {
  /** what the rows were built from — the screen builds each row's link and action from these (it owns the project rules for links) */
  snapshot: TodaySnapshot;
  notificationHrefById: Record<string, string | null>;
  runConversationById: Record<string, string | null>;
}

export interface HomeModelState {
  /** null until the first answer (or when it failed and nothing was ever read) */
  model: HomeModel | null;
  sources: HomeSources | null;
  loadError: boolean;
  retry: () => void;
}

const NONE: HomeModelState = { model: null, sources: null, loadError: false, retry: () => {} };
const HomeModelContext = createContext<HomeModelState>(NONE);

/** the model the navigation bar and the home screen share (an empty state when no provider is mounted) */
export function useHomeModel(): HomeModelState {
  return useContext(HomeModelContext);
}

interface RawNotification extends HomeNotificationInput { href?: string | null }
interface RawStory { id: string; title: string; status: string; assignee_id?: string | null; assignee_ids?: string[] | null; updated_at?: string | null; project_id?: string | null }
interface RawMember { id: string; name?: string | null; type?: string | null }

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetchWithAuth(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function toStoryInputs(stories: RawStory[], members: RawMember[]): HomeStoryInput[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return stories.map((s) => {
    const ids = s.assignee_ids && s.assignee_ids.length > 0 ? s.assignee_ids : s.assignee_id ? [s.assignee_id] : [];
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      assignees: ids.flatMap((id) => {
        const m = byId.get(id);
        return m ? [{ id, type: m.type === 'agent' ? ('agent' as const) : ('human' as const), name: m.name ?? null }] : [];
      }),
      updatedAt: s.updated_at ?? '',
      projectId: s.project_id ?? null,
    };
  });
}

function toDoneInputs(items: TodayCompletedItem[]): HomeDoneInput[] {
  return items.map((d) => ({
    id: d.runId,
    title: d.workItemTitle ?? d.resultSummary ?? d.agentName,
    actor: d.agentName ? { type: 'agent' as const, name: d.agentName } : null,
    completedAt: d.finishedAt,
  }));
}

export function HomeModelProvider({ viewerMemberId, projectId, children }: { viewerMemberId: string | null; projectId: string | undefined; children: ReactNode }) {
  const [state, setState] = useState<{ model: HomeModel | null; sources: HomeSources | null; loadError: boolean }>({ model: null, sources: null, loadError: false });
  const [nonce, setNonce] = useState(0);
  const run = useRef(0);

  useEffect(() => {
    const myRun = ++run.current;
    let alive = true;
    const load = async () => {
      // the snapshot decides success: without it there is no home. The other two reads only add rows — a failed one adds none (an empty list, not a wrong number).
      const [todayJson, notifJson, storiesJson, membersJson] = await Promise.all([
        readJson<unknown>('/api/today'),
        readJson<{ data?: RawNotification[] }>('/api/notifications?unread=true'),
        projectId ? readJson<{ data?: RawStory[] }>(`/api/stories?${new URLSearchParams({ project_id: projectId, status: 'in-progress', limit: '100' })}`) : Promise.resolve(null),
        projectId ? readJson<{ data?: RawMember[] }>(`/api/members?project_id=${encodeURIComponent(projectId)}`) : Promise.resolve(null),
      ]);
      if (!alive || myRun !== run.current) return; // a later run (project change · retry) owns the state now
      if (todayJson === null) { setState((prev) => ({ ...prev, loadError: true })); return; }
      const snapshot = parseToday(todayJson) ?? EMPTY_TODAY_SNAPSHOT;
      const notifications = notifJson?.data ?? [];
      const model = deriveHome({
        snapshot,
        notifications,
        stories: toStoryInputs(storiesJson?.data ?? [], membersJson?.data ?? []),
        completedToday: toDoneInputs(snapshot.completedToday ?? []),
        viewerMemberId,
      });
      setState({
        model,
        loadError: false,
        sources: {
          snapshot,
          notificationHrefById: Object.fromEntries(notifications.map((n) => [n.id, n.href ?? null])),
          runConversationById: Object.fromEntries((snapshot.completedToday ?? []).map((d) => [d.runId, d.conversationId])),
        },
      });
    };
    void load();
    const timer = setInterval(() => { void load(); }, HOME_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [projectId, viewerMemberId, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const value = useMemo<HomeModelState>(() => ({ ...state, retry }), [state, retry]);
  return <HomeModelContext.Provider value={value}>{children}</HomeModelContext.Provider>;
}
