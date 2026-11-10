'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { parseCursorMeta } from '@/lib/pagination';
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
 *
 * Honesty rules (each has a test):
 *  - the newest load wins: an older answer that arrives late (a poll overlapping a «tab is back» read) is dropped;
 *  - what is project-scoped (the stories) belongs to the project it was read for — after a project switch the OLD project's stories are not shown for the new one (the approvals · notifications
 *    · today's results are the person's, not the project's, so they stay while the new project's stories are on their way);
 *  - what was read belongs to the person AND organization it was read for: after an organization (or member) switch nothing of the old one is shown while the new answer is on its way;
 *  - what is read is read to its end or said to be cut: unread notifications are read page by page (50 each, up to `NOTIFICATION_PAGES`), the stories in one page of 100 — when the server says there is
 *    more than was read, the model is `partial` (its number is «at least»), never a silent cut;
 *  - a load error belongs to the organization / member it happened for (a new identity starts clean);
 *  - the snapshot decides success; when notifications · stories · members fail, the model is still built from what was read but is `partial` (the screen never calls an empty partial list «all caught up»).
 */

export const HOME_POLL_MS = 60_000;
/** unread notifications are read in pages of 50: the newest ones first, up to this many pages (250) — most unread ones are approvals and chat messages, so an actionable one can be far down */
export const NOTIFICATION_PAGES = 5;

export interface HomeSources {
  /** what the rows were built from — the screen builds each row's link and action from these (it owns the project rules for links) */
  snapshot: TodaySnapshot;
  notificationHrefById: Record<string, string | null>;
  runConversationById: Record<string, string | null>;
}

export interface HomeModelState {
  /** null until the first answer */
  model: HomeModel | null;
  sources: HomeSources | null;
  /** the last read failed (the model, if any, is the last one that was read — the screen says so) */
  loadError: boolean;
  /** the model is built from an incomplete read (notifications · stories · members failed): its number is «at least», and an empty list must not be called «all caught up» */
  partial: boolean;
  retry: () => void;
}

const NONE: HomeModelState = { model: null, sources: null, loadError: false, partial: false, retry: () => {} };
const HomeModelContext = createContext<HomeModelState>(NONE);

/** the model the navigation bar and the home screen share (an empty state when no provider is mounted) */
export function useHomeModel(): HomeModelState {
  return useContext(HomeModelContext);
}

interface Page<T> { data?: T[]; meta?: unknown }
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

/** the page sizes the two routes use (the notification list route reads 50 · the stories read asks for 100): a page shorter than its size cannot have a next one */
const NOTIFICATION_PAGE_SIZE = 50;
const STORIES_PAGE_SIZE = 100;

/**
 * Is there nothing more after this page? The answer's own page meta is read by the codebase's one reader (`parseCursorMeta`). No meta at all → only a SHORT page is known to be the last; a meta in no known
 * shape, or «more» without a cursor to ask with → not complete (never «complete» by default).
 */
function pageIsLast(meta: unknown, got: number, pageSize: number, source: string): { last: boolean; cursor: string | null } {
  if (meta === undefined || meta === null) return { last: got < pageSize, cursor: null };
  const pageInfo = parseCursorMeta(meta, source);
  if (pageInfo.malformed) return { last: false, cursor: null };
  if (!pageInfo.hasMore) return { last: true, cursor: null };
  return { last: false, cursor: pageInfo.nextCursor };
}

/**
 * The unread notifications, newest first, page by page. `complete` = the server has no more after the last page read. `failed` = a page after the first one failed to read (the items of the pages
 * before it are kept, but the read is not trustworthy as a replacement of a complete earlier one); `null` = the first page failed.
 */
async function readUnreadNotifications(): Promise<{ items: RawNotification[]; complete: boolean; failed: boolean } | null> {
  const items: RawNotification[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < NOTIFICATION_PAGES; page += 1) {
    const params = new URLSearchParams({ unread: 'true' });
    if (cursor) params.set('cursor', cursor);
    const json: Page<RawNotification> | null = await readJson<Page<RawNotification>>(`/api/notifications?${params}`);
    if (json === null) return page === 0 ? null : { items, complete: false, failed: true };
    const got = json.data ?? [];
    items.push(...got);
    const next = pageIsLast(json.meta, got.length, NOTIFICATION_PAGE_SIZE, 'home/notifications');
    if (next.last) return { items, complete: true, failed: false };
    if (!next.cursor) return { items, complete: false, failed: false }; // «more», but nothing to ask for it with
    cursor = next.cursor;
  }
  return { items, complete: false, failed: false }; // the page cap: there is more than was read
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

interface Read {
  snapshot: TodaySnapshot;
  notifications: RawNotification[];
  stories: HomeStoryInput[];
  /** the project the stories were read for */
  storiesFor: string | undefined;
  /** whose read this is: the organization and the member (an organization switch must not show the old organization's approvals) */
  forOrg: string | undefined;
  forViewer: string | null;
  partial: boolean;
}

export function HomeModelProvider({ viewerMemberId, projectId, orgId, children }: { viewerMemberId: string | null; projectId: string | undefined; orgId?: string; children: ReactNode }) {
  const [readAny, setRead] = useState<Read | null>(null);
  // the identity a load error happened for (`org|member`): an error of the old identity is not the new one's
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const identity = `${orgId ?? ''}|${viewerMemberId ?? ''}`;
  const loadError = errorFor === identity;
  const [nonce, setNonce] = useState(0);
  // every load that starts takes the next number; only the newest one may commit (an older answer that arrives late — a poll overlapping a «tab is back» read, a project switch — is dropped)
  const seq = useRef(0);
  // a load is on its way: the 60-second tick does not start a second one beside it (the «tab is back» read and a retry still do — the newest wins)
  const inFlight = useRef(false);
  const lastRead = useRef<Read | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (fromTick = false) => {
      if (fromTick && inFlight.current) return;
      const mySeq = ++seq.current;
      inFlight.current = true;
      const [todayJson, notifRead, storiesJson, membersJson] = await Promise.all([
        readJson<unknown>('/api/today'),
        readUnreadNotifications(),
        projectId ? readJson<Page<RawStory>>(`/api/stories?${new URLSearchParams({ project_id: projectId, status: 'in-progress', limit: '100' })}`) : Promise.resolve(null),
        projectId ? readJson<{ data?: RawMember[] }>(`/api/members?project_id=${encodeURIComponent(projectId)}`) : Promise.resolve(null),
      ]);
      if (mySeq === seq.current) inFlight.current = false;
      if (!alive || mySeq !== seq.current) return; // a newer load owns the state now
      // a complete read of this very identity must not be replaced by one that broke off in the middle (the badge would drop and come back): the earlier one stays and the screen says the last read failed
      const prev = lastRead.current;
      if (todayJson !== null && notifRead?.failed && prev && prev.forOrg === orgId && prev.forViewer === viewerMemberId && !prev.partial) {
        setErrorFor(`${orgId ?? ''}|${viewerMemberId ?? ''}`);
        return;
      }
      if (todayJson === null) { setErrorFor(`${orgId ?? ''}|${viewerMemberId ?? ''}`); return; } // the snapshot decides success; the last model (if any) stays, and the screen says it is the last one
      setErrorFor(null);
      const next: Read = {
        snapshot: parseToday(todayJson) ?? EMPTY_TODAY_SNAPSHOT,
        notifications: notifRead?.items ?? [],
        stories: toStoryInputs(storiesJson?.data ?? [], membersJson?.data ?? []),
        storiesFor: projectId,
        forOrg: orgId,
        forViewer: viewerMemberId,
        // the other reads only add rows: a failed one leaves the model honest but incomplete
        partial: notifRead === null || !notifRead.complete
          || (projectId !== undefined && (storiesJson === null || membersJson === null || !pageIsLast(storiesJson.meta, (storiesJson.data ?? []).length, STORIES_PAGE_SIZE, 'home/stories').last)),
      };
      lastRead.current = next;
      setRead(next);
    };
    void load();
    const timer = setInterval(() => { void load(true); }, HOME_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [projectId, viewerMemberId, orgId, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const value = useMemo<HomeModelState>(() => {
    // a read of another organization or member is not this one's: none of it is shown while the new answer is on its way
    const read = readAny && readAny.forOrg === orgId && readAny.forViewer === viewerMemberId ? readAny : null;
    if (!read) return { model: null, sources: null, loadError, partial: false, retry };
    const model = deriveHome({
      snapshot: read.snapshot,
      notifications: read.notifications,
      // the stories belong to the project they were read for
      stories: read.storiesFor === projectId ? read.stories : [],
      completedToday: toDoneInputs(read.snapshot.completedToday ?? []),
      viewerMemberId,
    });
    return {
      model,
      loadError,
      // the stories of another project than the current one are as good as unread, until the new project's answer comes
      partial: read.partial || read.storiesFor !== projectId,
      retry,
      sources: {
        snapshot: read.snapshot,
        notificationHrefById: Object.fromEntries(read.notifications.map((n) => [n.id, n.href ?? null])),
        runConversationById: Object.fromEntries((read.snapshot.completedToday ?? []).map((d) => [d.runId, d.conversationId])),
      },
    };
  }, [readAny, loadError, projectId, viewerMemberId, orgId, retry]);
  return <HomeModelContext.Provider value={value}>{children}</HomeModelContext.Provider>;
}
