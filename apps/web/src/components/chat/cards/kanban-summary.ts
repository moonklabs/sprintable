import { EntitySummaryError } from '@/components/chat/embed-card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story 5034 (C4 step 3) — what a sprint's board card shows: the sprint's name and status, how many stories stand in each column, and the few that are being worked on. Read-only, read for THE
 * VIEWER through two of the web's own reads (`/api/sprints/{id}` · `/api/stories?sprint_id=`) — the server decides what this person may see; a card never does. Each body is read in its one shape
 * (`{ data }`); anything else is a retryable fault.
 */
export const KANBAN_COLUMNS = ['backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done'] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];
/** one page of stories is read (the route's own cap is 100); a board with more says so instead of showing a wrong total */
export const KANBAN_PAGE = 100;
/** how many «being worked on» titles the card lists */
export const KANBAN_NOW_MAX = 3;

export interface KanbanSummary {
  title: string | null;
  status: string | null;
  total: number;
  counts: Record<KanbanColumn, number>;
  now: { id: string; number: number | null; title: string }[];
  hasMore: boolean;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const isColumn = (s: unknown): s is KanbanColumn => typeof s === 'string' && (KANBAN_COLUMNS as readonly string[]).includes(s);

async function dataOf(res: Response): Promise<{ data: unknown; meta: unknown }> {
  if (!res.ok) throw new EntitySummaryError(res.status);
  const body = (await res.json()) as { data?: unknown; meta?: unknown };
  return { data: body.data, meta: body.meta };
}

export async function fetchKanbanSummary(sprintId: string): Promise<KanbanSummary> {
  const id = encodeURIComponent(sprintId);
  let sprintRes: Response; let storiesRes: Response;
  try {
    [sprintRes, storiesRes] = await Promise.all([fetchWithAuth(`/api/sprints/${id}`), fetchWithAuth(`/api/stories?sprint_id=${id}&limit=${KANBAN_PAGE}`)]);
  } catch {
    throw new EntitySummaryError(502); // a read that did not even answer (network) is a fault worth a «try again», whichever leg it was
  }
  const sprint = (await dataOf(sprintRes)).data;
  const { data: stories, meta } = await dataOf(storiesRes);
  if (typeof sprint !== 'object' || sprint === null || Array.isArray(sprint) || !Array.isArray(stories)) throw new EntitySummaryError(502);
  const s = sprint as Record<string, unknown>;
  const counts = Object.fromEntries(KANBAN_COLUMNS.map((c) => [c, 0])) as Record<KanbanColumn, number>;
  const now: KanbanSummary['now'] = [];
  for (const row of stories) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.is_excluded === true) continue; // the board hides excluded stories (live-QA cards · opted out) — so does this card
    if (!isColumn(r.status)) continue;
    counts[r.status]++;
    if ((r.status === 'in-progress' || r.status === 'in-review') && now.length < KANBAN_NOW_MAX && typeof r.id === 'string') {
      now.push({ id: r.id, number: typeof r.story_number === 'number' ? r.story_number : null, title: text(r.title) ?? r.id });
    }
  }
  const total = KANBAN_COLUMNS.reduce((n, c) => n + counts[c], 0);
  return { title: text(s.name) ?? text(s.title), status: text(s.status), total, counts, now, hasMore: typeof meta === 'object' && meta !== null && (meta as { hasMore?: unknown }).hasMore === true };
}
