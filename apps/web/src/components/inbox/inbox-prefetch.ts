/**
 * story #4276(E-MOBILE-SPEED · 민 기기 배포 27) — 결재 탭 데이터 요청 선출발.
 *
 * 왜: 결재(/inbox) 화면은 클라이언트 컴포넌트라 데이터 요청 넷(gates/inbox pending · held · notifications 1쪽 · workflow-executions)이
 * /inbox RSC(460~600ms)를 다 받고 하이드레이션한 **뒤** useEffect에서야 출발했다(탭 +608~946ms 출발 · 각 0.6~1.06초 — 폭포).
 * `inbox/loading.tsx`는 누른 즉시 그려지므로(4274) 그 순간 요청을 먼저 출발시키고, 화면이 붙으면 같은 요청의 응답을 **한 번** 넘겨받는다.
 *
 * 넘겨받기 규칙(오래된 값이 화면에 서지 않게):
 * - 1회용: 넘겨준 항목은 바로 지운다. 그 뒤 새로고침 · 15초 폴링 · 더 보기는 늘 새 요청.
 * - 기한: 선출발 시각부터 PREFETCH_TTL_MS(10초)가 지나면 버리고 새로 요청한다 — 화면 폴링 주기(15초)보다 짧아 폴링보다 오래된 값이 설 일이 없다.
 * - 범위: 항목마다 선출발한 사람(member) · 프로젝트를 같이 적고, 넘겨받는 쪽의 현재 값과 다르면 버린다(그 사이 프로젝트 · 계정 전환).
 * - 탭: gates 요청은 결재 탭(`?tab=gates`)으로 올 때만 선출발한다(다른 탭으로 오면 안 쓰는 요청이 되니).
 */
import { fetchWithAuth } from '@/lib/db/client';

export const PREFETCH_TTL_MS = 10_000;

export const INBOX_GATES_PENDING_URL = '/api/gates/inbox?status=pending&sort=urgency&assigned_to_me=true';
export const INBOX_GATES_HELD_URL = '/api/gates/inbox?status=held&sort=urgency&assigned_to_me=true';

/** 알림 목록 요청 주소 — 화면(`fetchInboxNotifications`)과 선출발이 같은 주소를 만들어야 넘겨받기가 맞는다. */
export function inboxNotificationsUrl(typeFilter = '', cursor?: string | null): string {
  const params = new URLSearchParams();
  if (typeFilter) params.set('type', typeFilter);
  if (cursor) params.set('cursor', cursor);
  return `/api/notifications?${params}`;
}

export function inboxWorkflowExecutionsUrl(projectId: string, memberId: string): string {
  const params = new URLSearchParams({ project_id: projectId, member_id: memberId, limit: '10' });
  return `/api/workflow-executions?${params.toString()}`;
}

export interface InboxPrefetchScope {
  memberId: string | null | undefined;
  projectId: string | null | undefined;
}

interface Entry {
  startedAt: number;
  scopeKey: string;
  response: Promise<Response>;
}

const entries = new Map<string, Entry>();

function scopeKeyOf(scope: InboxPrefetchScope): string {
  return `${scope.memberId ?? ''}|${scope.projectId ?? ''}`;
}

function start(url: string, scope: InboxPrefetchScope, now: number): void {
  const existing = entries.get(url);
  if (existing && existing.scopeKey === scopeKeyOf(scope) && now - existing.startedAt <= PREFETCH_TTL_MS) return;
  const response = fetchWithAuth(url);
  // 아무도 안 넘겨받고 기한이 지나 버려질 수 있다 — 그때 실패가 «처리 안 된 거부»로 새지 않게. 넘겨받는 쪽은 원래 promise로 실패를 그대로 받는다.
  response.catch(() => {});
  entries.set(url, { startedAt: now, scopeKey: scopeKeyOf(scope), response });
}

/** `inbox/loading.tsx`가 뜨는 순간 부른다. `tab`은 도착 주소의 `?tab=` 값. */
export function prefetchInbox(scope: InboxPrefetchScope, tab: string | null, now: number = Date.now()): void {
  start(inboxNotificationsUrl(), scope, now);
  if (scope.memberId && scope.projectId) start(inboxWorkflowExecutionsUrl(scope.projectId, scope.memberId), scope, now);
  if (tab === 'gates') {
    start(INBOX_GATES_PENDING_URL, scope, now);
    start(INBOX_GATES_HELD_URL, scope, now);
  }
}

/** 선출발한 같은 요청이 규칙(1회용 · 기한 · 범위)에 맞으면 그 응답을, 아니면 새로 요청한다. */
export function takePrefetchedOrFetch(url: string, scope: InboxPrefetchScope, now: number = Date.now()): Promise<Response> {
  const entry = entries.get(url);
  entries.delete(url);
  if (entry && entry.scopeKey === scopeKeyOf(scope) && now - entry.startedAt <= PREFETCH_TTL_MS) return entry.response;
  return fetchWithAuth(url);
}

/** 테스트 전용 — 모듈 상태 비우기. */
export function __resetInboxPrefetchForTest(): void {
  entries.clear();
}
