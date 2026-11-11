/**
 * story #4888 (UI-5 AC4, first piece) — «홈» (formerly the screen called «오늘»): the ONE list the person opens first, as a pure function. No fetch, no React, no i18n —
 * the data layer hands in what the existing routes already give (today snapshot · notifications · my stories) and this decides the three sections, their order, the one number
 * and which row is selected. Design: doc ui5-4888-ac3-today-b-skeleton-draft-v0 (§1 · §2 · §5).
 *
 * The rules (each has a test that fails when it is undone):
 *  1. ONE number — `badge` = the number of rows in «내 손이 필요해요» = the number in the header line. The bell (58), the inbox (42), the chat badge (16) and the old «오늘» (0) stopped
 *     answering the same question with four different numbers.
 *  2. What counts as «my hand is needed»: the approvals/answers the today snapshot already lists (`needsMe`) + the UNREAD notifications whose `type` says a person must act
 *     (mention · assignment · permission request · stopped · limit paused). `gate.pending_approval` is NEVER counted on top — it is the same thing as the approval row
 *     (counting both would break rule 1). `conversation.message` belongs to the chat badge; status changes · system dispatches · «limit lifted» are information, not a task.
 *  3. Longest wait first (`since` ascending, ties by key) — the order of the existing `needs_me` list; the first 5 are shown and «N more» says how many are folded.
 *  4. «일하는 중» = the agent runs of the snapshot + the in-progress stories assigned to me or to an agent (the old screen showed 0 of 14 stories — AC1 problem 5).
 *  5. «방금 끝남» = what finished today, most recent first.
 *  6. After an action the next row is selected (3 taps → 1): `selectAfterHandled`.
 */
import type { TodayAgentProgressItem, TodayNeedsMeItem, TodaySnapshot } from '../org-briefing/derive-today';

export type HomeSection = 'needs-hand' | 'working' | 'just-done';
export type HomeRowKind =
  | 'approval' | 'signature' | 'answer'                         // from the today snapshot (`needsMe`)
  | 'mention' | 'assigned' | 'permission' | 'stopped' | 'limit-paused' // from unread notifications
  | 'agent-run' | 'story'                                        // working
  | 'done';

export interface HomeActor {
  type: 'agent' | 'human';
  name: string | null;
}

export interface HomeRow {
  /** stable key (`gate|hitl|workflow_step:<id>` · `notification:<id>` · `run:<id>` · `story:<id>` · `done:<id>`) */
  key: string;
  section: HomeSection;
  kind: HomeRowKind;
  title: string;
  actor: HomeActor | null;
  /** when the wait / the work started (ISO) — for «done» the time it finished */
  since: string;
  /** what the row points at (the caller builds the link with its own project rules) */
  ref: { type: 'gate' | 'hitl' | 'workflow_step' | 'notification' | 'agent_run' | 'story'; id: string; projectId: string | null };
}

/** the notification as the existing list route gives it (only the fields this function reads) */
export interface HomeNotificationInput {
  id: string;
  type: string;
  title: string;
  is_read: boolean;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface HomeStoryInput {
  id: string;
  title: string;
  status: string;
  assignees: Array<{ id: string; type: 'human' | 'agent'; name: string | null }>;
  updatedAt: string;
  projectId?: string | null;
}

export interface HomeDoneInput {
  id: string;
  title: string;
  actor: HomeActor | null;
  completedAt: string;
}

export interface HomeInput {
  snapshot: Pick<TodaySnapshot, 'needsMe' | 'agentProgress'>;
  notifications: HomeNotificationInput[];
  stories: HomeStoryInput[];
  completedToday: HomeDoneInput[];
  /** the signed-in member (human) — «my» stories */
  viewerMemberId: string | null;
}

export interface HomeModel {
  /** the one number: rows in «내 손이 필요해요» — also what the navigation badge shows */
  badge: number;
  header: { needsHand: number; working: number; justDone: number };
  needsHand: HomeRow[];
  working: HomeRow[];
  justDone: HomeRow[];
  /** first `NEEDS_HAND_VISIBLE` rows of `needsHand` and how many are folded behind «N개 더 보기» */
  needsHandVisible: HomeRow[];
  needsHandHidden: number;
  /** the row selected on the first open (the first one that needs a hand), or null */
  initialSelection: string | null;
}

export const NEEDS_HAND_VISIBLE = 5;

/** notification `type` (the event_type the server published) → the kind of a task that needs a person */
export const HOME_NEEDS_HAND_NOTIFICATION_TYPES: Readonly<Record<string, HomeRowKind>> = {
  'conversation.mention': 'mention',
  story_assigned: 'assigned',
  task_assigned: 'assigned',
  'agent.permission_request': 'permission',
  'agent.restart_stopped': 'stopped',
  'agent.limit_paused': 'limit-paused',
};


/**
 * story #4888 (PO 11-11 20:10Z) — inside «손 필요», the requests a person must press for an agent to move on (an approval · a signature · an answer) come BEFORE the notifications that went by (a mention · an assignment …).
 * Found on the real thing: a decision request that had just arrived sat behind seven 38-hour-old notifications, hidden behind «5개 더 보기», though it is what a blocked agent waits for — freeing the blocked agent first is what the home is for.
 * Inside each of the two groups the order is what it was: the longest wait first, ties by key. The number (badge · header) is unchanged — only the order inside the one list.
 */
const AGENT_WAITS_FOR_ME: ReadonlySet<HomeRowKind> = new Set<HomeRowKind>(['approval', 'signature', 'answer']);

function needsHandOrder(a: HomeRow, b: HomeRow): number {
  const ra = AGENT_WAITS_FOR_ME.has(a.kind) ? 0 : 1;
  const rb = AGENT_WAITS_FOR_ME.has(b.kind) ? 0 : 1;
  return ra !== rb ? ra - rb : byWait(a, b);
}

function byWait(a: HomeRow, b: HomeRow): number {
  return a.since < b.since ? -1 : a.since > b.since ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function needsMeRow(item: TodayNeedsMeItem): HomeRow {
  return {
    // the source is part of the key: gate · hitl · workflow-step ids are three separate id spaces, and two of them may meet
    key: `${item.source}:${item.id}`,
    section: 'needs-hand',
    kind: item.state,
    title: item.workItemTitle,
    actor: item.requestedByName ? { type: 'agent', name: item.requestedByName } : null,
    since: item.createdAt,
    ref: { type: item.source === 'gate' ? 'gate' : item.source, id: item.id, projectId: item.projectId },
  };
}

function notificationRow(n: HomeNotificationInput, kind: HomeRowKind): HomeRow {
  return {
    key: `notification:${n.id}`,
    section: 'needs-hand',
    kind,
    title: n.title,
    actor: null,
    since: n.created_at,
    ref: { type: 'notification', id: n.id, projectId: null },
  };
}

function agentRunRow(run: TodayAgentProgressItem): HomeRow {
  return {
    key: `run:${run.runId}`,
    section: 'working',
    kind: 'agent-run',
    title: run.workItemTitle ?? run.agentName,
    actor: { type: 'agent', name: run.agentName },
    since: run.startedAt,
    ref: { type: 'agent_run', id: run.runId, projectId: null },
  };
}

function storyRow(s: HomeStoryInput, viewerMemberId: string | null): HomeRow | null {
  if (s.status !== 'in-progress') return null;
  const agent = s.assignees.find((a) => a.type === 'agent');
  const mine = viewerMemberId !== null && s.assignees.some((a) => a.id === viewerMemberId);
  if (!agent && !mine) return null; // somebody else's human work is not mine to look at
  const who = agent ?? s.assignees.find((a) => a.id === viewerMemberId) ?? null;
  return {
    key: `story:${s.id}`,
    section: 'working',
    kind: 'story',
    title: s.title,
    actor: who ? { type: who.type, name: who.name } : null,
    since: s.updatedAt,
    ref: { type: 'story', id: s.id, projectId: s.projectId ?? null },
  };
}

export function deriveHome(input: HomeInput): HomeModel {
  const needsHand: HomeRow[] = input.snapshot.needsMe.map(needsMeRow);

  for (const n of input.notifications) {
    if (n.is_read) continue;
    // `gate.pending_approval` (and every type not listed) never adds a row — the approval row already counts the same thing
    const kind = HOME_NEEDS_HAND_NOTIFICATION_TYPES[n.type];
    if (!kind) continue;
    needsHand.push(notificationRow(n, kind));
  }
  needsHand.sort(needsHandOrder);

  const working: HomeRow[] = [
    // `agent_progress` IS the backend's list of runs in progress (today_service filters it by its in-progress statuses): every run in it is a working row. The screen does not re-filter it by a status list of its own
    // (a status the backend adds later must not make a run vanish from the home) — it only names the statuses it knows.
    ...input.snapshot.agentProgress.map(agentRunRow),
    ...input.stories.map((s) => storyRow(s, input.viewerMemberId)).filter((r): r is HomeRow => r !== null),
  ].sort(byWait);

  const justDone: HomeRow[] = input.completedToday
    .map(
      (d): HomeRow => ({
        key: `done:${d.id}`,
        section: 'just-done',
        kind: 'done',
        title: d.title,
        actor: d.actor,
        since: d.completedAt,
        ref: { type: 'story', id: d.id, projectId: null },
      }),
    )
    .sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : a.key < b.key ? -1 : 1));

  return {
    badge: needsHand.length,
    header: { needsHand: needsHand.length, working: working.length, justDone: justDone.length },
    needsHand,
    working,
    justDone,
    needsHandVisible: needsHand.slice(0, NEEDS_HAND_VISIBLE),
    needsHandHidden: Math.max(0, needsHand.length - NEEDS_HAND_VISIBLE),
    initialSelection: needsHand[0]?.key ?? null,
  };
}

/**
 * After a row is handled (approved · answered · …) the list is re-derived without it and the NEXT row is selected: the one that now sits where the handled one was,
 * else the last one, else nothing. `before` is the «needs a hand» list as it was when the action was taken.
 */
export function selectAfterHandled(before: HomeRow[], handledKey: string): string | null {
  const i = before.findIndex((r) => r.key === handledKey);
  if (i === -1) return before[0]?.key ?? null;
  const rest = before.filter((r) => r.key !== handledKey);
  if (rest.length === 0) return null;
  return rest[Math.min(i, rest.length - 1)]!.key;
}
