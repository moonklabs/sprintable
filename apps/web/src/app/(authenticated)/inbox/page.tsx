'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, Bell, Bot, CheckCheck, ChevronDown, ChevronRight, Inbox as InboxIcon, Info, Zap, ZapOff, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { AgentIdentity } from '@/components/ui/agent-identity';
import { ApprovalsQueue } from '@/components/inbox/approvals-queue';
import { AttentionQueueView } from '@/components/attention-queue/attention-queue-view';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { useToast } from '@/components/ui/toast';
import { inboxNotificationsUrl, inboxWorkflowExecutionsUrl, takePrefetchedOrFetch, type InboxPrefetchScope } from '@/components/inbox/inbox-prefetch';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import {
  getInboxNotificationLabel,
  getNotificationReasonKey,
  NOTIFICATION_TYPE_ICONS,
} from '@/services/notification-display';
import { groupByIdenticalContent, referenceTypeLabel } from '@/lib/inbox-generic-notification-grouping';
import type { EventPreviewHelpers } from '@/components/chat/event-block-card';
import { composeNotificationDisplay, type Notification } from './inbox-notification-display';
import { useOrgDomainLabels } from '@/hooks/use-org-domain-labels';
import { useFlatHref } from '@/hooks/use-flat-href';

// 알림 type 아이콘 렌더 — NOTIFICATION_TYPE_ICONS(lucide)서 lookup·미상 type은 fallback 아이콘.
function NotifIcon({ type, fallback: Fallback, className }: { type: string; fallback: LucideIcon; className?: string }) {
  const Icon = NOTIFICATION_TYPE_ICONS[type] ?? Fallback;
  return <Icon className={className} />;
}

interface WorkflowExecItem {
  id: string;
  event_type: string;
  trigger_type_slug: string | null;
  rule_name: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
}

// f2ec5395: 인박스 렌더 단위 — 개별 알림(single) 또는 그룹(group). story #0d1c69f3(v2 4호)
// — 그룹은 두 갈래: 'status_change'(f2ec5395, 같은 스토리의 상태변경 반복 — reference_id로
// 묶음) · 'generic'(신규, 같은 type+제목+본문이 반복되는 제네릭 알림 — 라이브 실측 121건
// 「결재 대기 중인 게이트가 있습니다」류. content로 묶음, 대상은 서로 다름). groupKind로
// 펼침 콘텐츠를 분기한다(status_change=기존 title+time 행 그대로, generic=구체 참조 칩+CTA).
type InboxItem =
  | { kind: 'single'; notification: Notification; sortTime: number }
  | {
      kind: 'group';
      groupKind: 'status_change' | 'generic';
      key: string;
      notifications: Notification[];
      latest: Notification;
      count: number;
      hasUnread: boolean;
      sortTime: number;
    };

function AgentJoinedDetailPanel({
  notification,
  t,
  addToast,
  onRevoked,
}: {
  notification: Notification;
  t: (key: string) => string;
  addToast: (toast: { title: string; type?: 'success' | 'error' }) => void;
  onRevoked: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  async function handleRevoke() {
    if (!notification.reference_id) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/team-members/${notification.reference_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: false }),
      });
      if (res.ok) {
        addToast({ title: t('revoke_success'), type: 'success' });
        onRevoked();
      } else {
        addToast({ title: t('revoke_failed'), type: 'error' });
      }
    } catch {
      addToast({ title: t('revoke_failed'), type: 'error' });
    } finally {
      setRevoking(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 px-6 py-6">
      <div className="flex items-start gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white/6 text-muted-foreground">
          <Bot className="size-6" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t('filter_agent_joined')}</Badge>
            <span className="text-xs text-muted-foreground">
              {t('receivedAt')} · {formatRelativeTime(notification.created_at, locale, displayTimezone)}
            </span>
          </div>
          <h2 className="text-lg font-semibold text-foreground">{notification.title}</h2>
        </div>
      </div>

      {notification.body ? (
        <div className="rounded-xl border border-white/8 bg-muted/55 p-4 text-sm leading-6 text-foreground whitespace-pre-wrap">
          {notification.body}
        </div>
      ) : null}

      {notification.reference_id ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {confirming ? (
            <>
              <span className="text-sm text-muted-foreground">{t('revoke_agent_confirm')}</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleRevoke()}
                disabled={revoking}
              >
                {revoking ? '…' : t('revoke_agent')}
              </Button>
              <Button
                variant="glass"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={revoking}
              >
                {t('cancel')}
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirming(true)}
            >
              {t('revoke_agent')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// story #2195 — 기본(notifications) 탭이 서버 하드코딩 limit=50 + 커서 없음으로 51번째부터
// 조용히 잘렸다. BE(#2538, 규약 A)가 이제 has_more/next_cursor를 body meta로 낸다 —
// cursor를 실어 보내고 그 meta를 그대로 다음 요청에 이어 붙인다.
async function fetchInboxNotifications(typeFilter: string, cursor: string | null | undefined, scope: InboxPrefetchScope) {

  // story #4295 — 예외 처리가 없어 망 오류 · 깨진 JSON이면 여기서 던졌고, 부르는 쪽(load · 더 보기)의 로딩 상태가 되돌려지지 않아
  // 알림 목록이 영원히 «불러오는 중» · «더 보기»가 눌린 채로 막혔다. 이제 실패는 전부 null(부르는 쪽이 실패로 다룬다) — 던지지 않는다.
  // 선출발 응답(#4276)을 넘겨받은 경우도 같다 — 그 요청이 실패(거부 · !ok · 깨진 JSON)면 같은 null로 같은 실패 상자.
  try {
    // story #2689 — 콜드 재진입 시 raw fetch는 401을 재시도 없이 삼켜(!res.ok=>null) 알림
    // 목록이 빈 채로 남았다. fetchWithAuth로 401→refresh→재시도 경로에 태운다.
    // story #4276 — inbox/loading.tsx가 먼저 출발시킨 1쪽 요청이 있으면 그 응답을 한 번 넘겨받는다(규칙은 inbox-prefetch.ts).
    const res = await takePrefetchedOrFetch(inboxNotificationsUrl(typeFilter, cursor), scope);
    if (!res.ok) return null;

    const json = await res.json();
    return {
      notifications: (json.data ?? []) as Notification[],
      unreadCount: (json.meta?.unreadCount ?? 0) as number,
      hasMore: (json.meta?.hasMore ?? false) as boolean,
      nextCursor: (json.meta?.nextCursor ?? null) as string | null,
    };
  } catch {
    return null;
  }
}

export default function InboxPage() {
  const router = useRouter();
  // story #4226 — 인박스 내부 탭 이동도 `?p=`를 싣는다(셸의 착지 정규화 router.replace = 현재 페이지 RSC 재요청 0).
  const flatHref = useFlatHref();
  const searchParams = useSearchParams();
  const t = useTranslations('inbox');
  const tCommon = useTranslations('common');
  const tCage = useTranslations('cage');
  // story #3903 AC2 — 3888 eventCard 조합(composeEventPreviewLine) 재사용 재료. 알림
  // 목록/상세가 raw preset 키를 그대로 보여주던 결함(대화 목록은 3888이 이미 고쳤고, 알림
  // 목록은 별개 소비처라 남아 있었다) 처방 — 새 낱말 0, 새 라벨 해석 로직 0.
  const tBoard = useTranslations('board');
  const tDashboard = useTranslations('dashboard');
  const tEventCard = useTranslations('eventCard');
  const tEntity = useTranslations('chats');
  const tOutcomeLoop = useTranslations('outcomeLoop');
  const locale = useLocale();
  // story #3493 — resolveDisplayTimezone() 호출을 useMemo로 감싸 값 안정성을 React
  // Compiler가 증명할 수 있게 한다(아래 inboxSections useMemo의 dep으로 쓰일 때
  // "may be mutated later"로 메모이제이션 보존을 포기하던 것의 근본 수정 — 이 값
  // 자체의 실제 산출 로직은 그대로, 안정화만 추가).
  const displayTimezone = useMemo(() => resolveDisplayTimezone().tz, []);
  const { currentTeamMemberId, projectId, orgId } = useDashboardContext();
  // story #4276 — 선출발 응답을 넘겨받을 때 범위 대조용(알림 콜백들의 의존성은 그대로 두려고 ref로).
  const prefetchScopeRef = useRef<InboxPrefetchScope>({ memberId: currentTeamMemberId, projectId });
  useEffect(() => {
    prefetchScopeRef.current = { memberId: currentTeamMemberId, projectId };
  }, [currentTeamMemberId, projectId]);
  // story #3903 AC2 — composeEventPreviewLine의 domainLabels 재료(org 커스텀 status
  // 라벨 오버라이드). chat-list-view.tsx의 기존 재사용 패턴과 동형.
  const domainLabels = useOrgDomainLabels(orgId, locale);
  const eventPreviewHelpers: EventPreviewHelpers = {
    tBoard, tCage, tDashboard, tEventCard, tEntity, tOutcomeLoop, domainLabels,
  };
  const activeTab = searchParams.get('tab') ?? 'notifications';
  // story #2164(2026-07-25, 까심): 예전엔 이 세 탭 중 notifications 탭 라벨과 페이지 헤더가
  // t('title')("결재함") 하나를 재사용했다 — 헤더가 항상 "결재함"이라 찍히는데 기본 진입 시
  // 보이는 건 무필터 알림 피드라 이름이 내용과 어긋났다(선생님 정신병 리스트 결재함1/결재함2
  // 둘 다 이 어긋남에서 발생). 탭마다 전용 키로 갈라(notificationsTabLabel/attentionTabLabel/
  // cage.gateTabLabel="결재함"으로 개명) 헤더가 항상 **현재 활성 탭의 진짜 이름**을 보여주게
  // 한다 — 탭을 이동해도 헤더가 거짓말하지 않는다.
  const INBOX_TABS = [
    { key: 'attention', label: t('attentionTabLabel') },
    { key: 'notifications', label: t('notificationsTabLabel') },
    { key: 'gates', label: tCage('gateTabLabel') },
  ] as const;
  const activeTabLabel = INBOX_TABS.find((tab) => tab.key === activeTab)?.label ?? t('notificationsTabLabel');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  // story #4295 — 첫 쪽을 못 불러왔으면 «알림 없음»(거짓 0건)이 아니라 실패 + 다시 시도.
  const [loadFailed, setLoadFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // story #2195 — 사용자가 "더 보기"로 두 번째 페이지 이상을 이미 펼친 뒤, 15초 폴링
  // 리프레시가 그 상태를 조용히 1페이지로 되돌리면 안 된다(펼친 걸 다시 접는 것으로 읽힌다).
  // 더 보기를 누른 적이 있으면 그 뒤로는 자동 폴링을 건너뛴다.
  const [pagedBeyondFirst, setPagedBeyondFirst] = useState(false);
  const [workflowExecs, setWorkflowExecs] = useState<WorkflowExecItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { addToast } = useToast();

  const refreshNotifications = useCallback(async () => {
    if (pagedBeyondFirst) return;
    const result = await fetchInboxNotifications('', null, prefetchScopeRef.current);
    // 폴링 실패는 조용히(보고 있던 목록을 그대로 둔다) — 첫 쪽 실패 뒤 폴링이 성공하면 실패 표시를 걷는다.
    if (!result) return;

    setLoadFailed(false);
    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
    setHasMore(result.hasMore);
    setNextCursor(result.nextCursor);
  }, [pagedBeyondFirst]);

  const loadMoreNotifications = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchInboxNotifications('', nextCursor, prefetchScopeRef.current);
      if (result) {
        setNotifications((prev) => [...prev, ...result.notifications]);
        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
        setPagedBeyondFirst(true);
      } else {
        // story #4295 — 실패를 알린다(버튼은 그대로 남아 다시 누르면 다시 시도).
        addToast({ title: t('loadMoreFailed'), type: 'error' });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, addToast, t]);

  // 첫 쪽 불러오기 — 마운트 때와 «다시 시도»가 같이 쓴다. `isCancelled`는 마운트 effect가 언마운트 뒤 상태를 안 쓰게.
  // story #4295(까디르) — 순번으로 늦게 온 옛 응답은 버린다(늦은 실패가 성공을 덮지 않게). 진행 중 표시(ref)는 가장 최근 호출의
  // finally에서 푼다 — «다시 시도»는 그걸 보고 연타를 막는다(아래 retryFirstPage). 마운트 effect는 막지 않는다: 개발 모드 StrictMode의
  // 이중 effect에서 첫 호출이 취소된 채 진행 중이라, 막으면 두 번째 호출이 출발하지 않아 영원히 «불러오는 중»이 된다.
  const firstPageInFlightRef = useRef(false);
  const firstPageSeqRef = useRef(0);
  const loadFirstPage = useCallback(async (isCancelled: () => boolean = () => false) => {
    firstPageInFlightRef.current = true;
    const seq = ++firstPageSeqRef.current;
    const stale = () => isCancelled() || seq !== firstPageSeqRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const result = await fetchInboxNotifications('', null, prefetchScopeRef.current);
      if (stale()) return;
      if (result) {
        setNotifications(result.notifications);
        setUnreadCount(result.unreadCount);
        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
      } else {
        setLoadFailed(true);
      }
    } finally {
      if (seq === firstPageSeqRef.current) firstPageInFlightRef.current = false;
      if (!stale()) setLoading(false);
    }
  }, []);
  const retryFirstPage = useCallback(() => {
    if (firstPageInFlightRef.current) return;
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    let cancelled = false;
    void loadFirstPage(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadFirstPage]);

  useEffect(() => {
    if (!currentTeamMemberId || !projectId) return;
    // story #2689 — 콜드 재진입 시 raw fetch는 401을 재시도 없이 삼켜(r.ok?...:null) 워크플로우
    // 실행 목록이 빈 채로 남았다. fetchWithAuth로 401→refresh→재시도 경로에 태운다(선출발 응답도 같은 fetchWithAuth).
    // story #4276 — inbox/loading.tsx가 먼저 출발시킨 같은 요청이 있으면 그 응답을 한 번 넘겨받는다.
    takePrefetchedOrFetch(inboxWorkflowExecutionsUrl(projectId, currentTeamMemberId), { memberId: currentTeamMemberId, projectId })
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (json?.items) setWorkflowExecs(json.items as WorkflowExecItem[]);
      })
      .catch(() => {});
  }, [currentTeamMemberId, projectId]);

  useEffect(() => {
    if (!currentTeamMemberId) return;

    const interval = setInterval(() => {
      void refreshNotifications();
    }, 15000);
    return () => clearInterval(interval);
  }, [currentTeamMemberId, refreshNotifications]);

  // story #4295 — 응답을 안 보고 읽음으로 바꾸던 자리(서버가 실패해도 화면은 읽음 · 망 오류면 처리 안 된 거부). 벨(handleMarkRead ·
  // story #3637)과 같은 문구로 실패를 알리고 화면은 그대로 둔다. 망 오류도 실패로 친다.
  // `silent`: 묶음처럼 여러 건을 한 번에 처리하는 호출부가 결과를 모아 토스트를 한 번만 띄우도록(4648 PO 검토).
  const setNotificationReadState = async (id: string, currentIsRead: boolean, nextIsRead: boolean, opts: { silent?: boolean } = {}): Promise<boolean> => {
    if (currentIsRead === nextIsRead) return true;

    const ok = await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, is_read: nextIsRead }),
    }).then((res) => res.ok, () => false);
    if (!ok) {
      if (!opts.silent) addToast({ title: t('markReadFailed'), type: 'error' });
      return false;
    }

    setNotifications((prev) => prev.map((notification) => (
      notification.id === id ? { ...notification, is_read: nextIsRead } : notification
    )));
    setUnreadCount((prev) => (nextIsRead ? Math.max(0, prev - 1) : prev + 1));
    return true;
  };

  const toggleRead = async (id: string, currentIsRead: boolean) => {
    await setNotificationReadState(id, currentIsRead, !currentIsRead);
  };

  const selectNotification = async (notification: Notification) => {
    setSelectedId(notification.id);
    if (!notification.is_read) {
      await setNotificationReadState(notification.id, notification.is_read, true);
    }
  };

  const openNotification = async (notification: Notification) => {
    if (!notification.is_read) {
      await setNotificationReadState(notification.id, notification.is_read, true);
    }
    if (notification.href) {
      router.push(notification.href);
    }
  };

  const markAllRead = async () => {
    // story #4295 — 위와 같은 부류(응답 안 봄) · 벨 handleMarkAllRead와 같은 문구.
    const ok = await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    }).then((res) => res.ok, () => false);
    if (!ok) {
      addToast({ title: t('markAllReadFailed'), type: 'error' });
      return;
    }
    setNotifications((prev) => prev.map((notification) => ({ ...notification, is_read: true })));
    setUnreadCount(0);
  };

  // story #3493 — 손으로 짠 상대시각(justNow/minutesAgo/hoursAgo)이 3436 묶음 8
  // 정본(formatRelativeTime)과 별개로 존재해 "한 제품에 시각 표기 두 벌"이던
  // 자리. 손대신 정본에 위임 — 폴백도 §11-2(toLocaleDateString 아님)로 통일된다.
  const formatTime = (iso: string) => formatRelativeTime(iso, locale, displayTimezone);

  const selectedNotification = useMemo(
    () => notifications.find((n) => n.id === selectedId) ?? null,
    [notifications, selectedId],
  );

  // story #3903 AC2 — 상세 패널 title/body도 목록 행과 동일하게 렌더 시점 조합(순수
  // 함수·저비용이라 useMemo 불요, composeEventPreviewLine 자체가 이미 매 렌더 재계산
  // 전제인 순수함수 — chat-list-view.tsx의 기존 호출 패턴과 동형).
  const selectedDisplay = selectedNotification
    ? composeNotificationDisplay(selectedNotification, t, eventPreviewHelpers)
    : null;

  // f2ec5395: 같은 스토리 status_changed 알림을 reference_id로 그룹(2건+). 타 type·단건은 개별 유지.
  // story #0d1c69f3(v2 4호) — status_change 그룹에 안 들어간 나머지 중 동일 type+제목+본문이
  // 반복되는 제네릭 알림(라이브 실측 121건 「결재 대기 중인 게이트가 있습니다」류)도 2건+면
  // 묶는다(groupByIdenticalContent, lib 순수함수·단위테스트 별도). 두 그룹 종류는 groupKind로
  // 구분해 펼침 렌더를 분기한다.
  const inboxItems = useMemo<InboxItem[]>(() => {
    const statusChangeGroups = new Map<string, Notification[]>();
    const items: InboxItem[] = [];
    const remainder: Notification[] = [];
    for (const n of notifications) {
      if (n.type === 'story_status_changed' && n.reference_id) {
        const arr = statusChangeGroups.get(n.reference_id) ?? [];
        arr.push(n);
        statusChangeGroups.set(n.reference_id, arr);
      } else {
        remainder.push(n);
      }
    }
    for (const [key, arr] of statusChangeGroups) {
      const sorted = [...arr].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const latest = sorted[0]!;
      const sortTime = new Date(latest.created_at).getTime();
      if (sorted.length === 1) {
        // 단건이면 noise 아님 → 개별 엔트리(그룹 chevron/카운트 없음).
        items.push({ kind: 'single', notification: latest, sortTime });
      } else {
        items.push({
          kind: 'group', groupKind: 'status_change', key, notifications: sorted, latest, count: sorted.length,
          hasUnread: sorted.some((n) => !n.is_read), sortTime,
        });
      }
    }

    const { groups: genericGroups, ungrouped } = groupByIdenticalContent(remainder);
    for (const n of ungrouped) {
      items.push({ kind: 'single', notification: n, sortTime: new Date(n.created_at).getTime() });
    }
    for (const g of genericGroups) {
      const sorted = [...g.notifications].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const latest = sorted[0]!;
      items.push({
        kind: 'group', groupKind: 'generic', key: `generic:${g.key}`, notifications: sorted, latest,
        count: sorted.length, hasUnread: sorted.some((n) => !n.is_read), sortTime: new Date(latest.created_at).getTime(),
      });
    }

    return items.sort((a, b) => b.sortTime - a.sortTime);
  }, [notifications]);

  // 목업 ③: inboxItems를 날짜 버킷(오늘/어제/날짜)으로 묶어 section 라벨 삽입(dense list 가독).
  const inboxSections = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    // story #3493(페드루 PO 보정) — 오늘/어제보다 오래된 날짜 버킷 라벨은
    // "기록"도 "약속"도 아닌 셋째 자리(날짜만 묶는 section 헤더, 시각 불요).
    // formatScheduledAt(...).display에서 "MM-DD"를 문자열로 발췌하던 첫 처방은
    // §11-2 포맷 문자열의 정확한 모양(공백 구분 순서)에 조용히 묶여, 그 포맷이
    // 바뀌면 이 구분선이 소리 없이 깨진다 — chat-view.tsx::groupByDate와 같은
    // 형(Intl.DateTimeFormat 직접 호출, schedule-format.ts::toDateKey와 동형
    // 패턴 — 새 포맷 함수 신설 아님)으로 맞춘다.
    const dateBucketFmt = new Intl.DateTimeFormat(locale, {
      month: '2-digit', day: '2-digit', timeZone: displayTimezone,
    });
    const labelFor = (time: number) => {
      if (time >= startOfToday) return t('dateToday');
      if (time >= startOfYesterday) return t('dateYesterday');
      return dateBucketFmt.format(new Date(time));
    };
    const sections: { label: string; items: InboxItem[] }[] = [];
    for (const item of inboxItems) {
      const label = labelFor(item.sortTime);
      const last = sections[sections.length - 1];
      if (last && last.label === label) last.items.push(item);
      else sections.push({ label, items: [item] });
    }
    return sections;
  }, [inboxItems, t, displayTimezone, locale]);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => setExpandedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // 그룹 헤더 클릭 → 그룹 전체 읽음 + (status_change만) 스토리 이동(AC2, f2ec5395).
  // story #0d1c69f3(v2 4호) — generic 그룹은 서로 다른 121개 대상을 묶은 것이라 "최신 1건"
  // 으로 임의 내비하면 나머지 120건의 실제 대상을 못 찾는다(정직 유의 위반) — 대신 펼쳐서
  // 항목별 구체 참조 칩+CTA(아래 렌더)로 실제 대상을 고르게 한다.
  const openGroup = async (group: Extract<InboxItem, { kind: 'group' }>) => {
    const unread = group.notifications.filter((n) => !n.is_read);
    // story #4295(PO 검토) — 건마다 토스트를 띄우면 묶음 크기만큼(generic 묶음은 121건까지) 같은 토스트가 쏟아졌다. 조용히 처리해 결과를
    // 모으고, 하나라도 실패면 한 번만. 실패한 건은 setNotificationReadState가 화면을 안 바꿔 안 읽음 그대로 남는다.
    const results = await Promise.all(unread.map((n) => setNotificationReadState(n.id, n.is_read, true, { silent: true })));
    if (results.includes(false)) addToast({ title: t('markReadFailed'), type: 'error' });
    if (group.groupKind === 'status_change' && group.latest.href) {
      router.push(group.latest.href);
    } else if (group.groupKind === 'generic') {
      toggleGroup(group.key);
    }
  };

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-medium">{activeTabLabel}</h1>
            {/* story #4281 — 이 숫자는 알림 탭의 안 읽은 수다. 오늘 · 결재함 탭엔 그 탭의 수를 모르므로 안 붙인다(예전엔 탭과
                무관하게 알림 수가 떠 «오늘 50»처럼 읽혔다). */}
            {activeTab === 'notifications' && unreadCount > 0 ? (
              <span className="text-sm tabular-nums text-muted-foreground">{unreadCount}</span>
            ) : null}
          </div>
        }
        actions={
          // story #4277 — 402폭에서 글자 버튼이 셸 TopBar의 shrink-0 액션 칸을 넓혀 상단바가 가로로 넘쳤다(409/402). 스프린트 상단바 관례:
          // 폰은 아이콘만 · 글자는 sm 이상 · 접근 이름은 aria-label로 유지.
          <Button variant="glass" size="sm" onClick={markAllRead} disabled={unreadCount === 0} aria-label={t('markAllRead')}>
            <CheckCheck className="size-4 sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">{t('markAllRead')}</span>
          </Button>
        }
        showContextChip
      />

      {/* story #4130 — 셸이 더 이상 뷰포트 높이 캡을 안 주므로(min-h-0 제거, #4121 픽스)
          이 탭 콘텐츠 영역(알림 탭은 리스트+상세 split, 각자 독립 overflow-y-auto)이 자기
          높이를 잃는다 — 여기서 직접 앵커(h-[calc(100svh-var(--shell-chrome-h))] — story
          #4131, --shell-chrome-h가 TopBar 표시 여부+모바일 탭바를 CSS만으로 합성한 SSOT). */}
      <div className="flex h-[calc(100svh-var(--shell-chrome-h))] min-h-0 flex-col overflow-hidden">
        {/* 탭 — 오늘(Attention Queue) / 알림 / 결재함(게이트). AQ는 전용 뷰로 병행 추가(기존 탭 대체 아님). */}
        <div className="flex shrink-0 border-b border-border/80 px-4">
          {INBOX_TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => router.replace(flatHref(`/inbox${key === 'notifications' ? '' : `?tab=${key}`}`), { scroll: false })}
              className={`border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
                activeTab === key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'attention' ? (
          <div className="flex-1 overflow-y-auto p-4">
            {projectId ? (
              <AttentionQueueView projectId={projectId} memberId={currentTeamMemberId} />
            ) : (
              <p className="text-xs text-muted-foreground">{tCommon('loading')}</p>
            )}
          </div>
        ) : activeTab === 'gates' ? (
          <div className="flex-1 overflow-y-auto p-4">
            <ApprovalsQueue />
          </div>
        ) : (
        <>
        {/* story #2923(P0-E AQ1) — DecisionsWaiting 패널 폐기(doc attention-audit-redesign-2923).
            그 데이터(/api/inbox pending)는 이제 attention 탭의 AttentionQueueView가 흡수해
            보여준다(별 패널 제거, GATE/STEER/BLOCK/Q 병합). */}
        {workflowExecs.length > 0 && (
          <div className="shrink-0 border-b border-border/80 px-4 py-3">
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">{t('workflowExecutionLabel')}</p>
            <div className="flex flex-col gap-1.5">
              {workflowExecs.slice(0, 5).map((exec) => (
                <div key={exec.id} className="flex items-center gap-2 rounded-lg bg-muted/55 px-3 py-2 text-xs">
                  {exec.status === 'matched' ? (
                    // story #2590(TIER1 아이콘) — text-warning은 tint 유무와 무관하게 3.0 미달
                    // (실측, #2420 doc) — text-foreground로 잠정 통일.
                    <Zap className="h-3.5 w-3.5 shrink-0 text-foreground" />
                  ) : (
                    <ZapOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {exec.rule_name ?? exec.event_type}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatRelativeTime(exec.completed_at ?? exec.created_at, locale, displayTimezone)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: notification list. max-lg master-detail (efcb3840 ⓑ, story #1986 breakpoint fix):
            full-width list, hidden once a detail is open so the detail can take the screen
            (lg+ unchanged). lg(1024px) matches MOBILE_BREAKPOINT/GNB lg:hidden SSOT — md(768px)
            caused a 768-1023 tablet seam where the mobile bottom-tab shell and this master-detail
            split disagreed on what "mobile" means. */}
        <div className={`flex w-full min-w-[320px] flex-col border-r border-border/80 lg:max-w-[420px] max-lg:min-w-0 ${selectedId ? 'max-lg:hidden' : ''}`}>
          <div className="focus-inset flex-1 overflow-y-auto py-2">
            {loading ? (
              <div className="space-y-2 px-3 pt-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ) : loadFailed ? (
              // story #4295 — 못 불러온 것은 «알림 없음»과 다른 사실 — 결재 큐(gate-inbox-load-error)와 같은 모양 · 다시 시도.
              <div className="mx-3 mt-2 rounded-xl border border-dashed border-destructive/30 bg-destructive-tint px-4 py-5 text-center" data-testid="inbox-notifications-load-error">
                <p className="text-sm text-foreground">{t('notificationsLoadError')}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={retryFirstPage}>
                  {tCommon('retry')}
                </Button>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <p className="text-sm text-muted-foreground">{t('noNotifications')}</p>
              </div>
            ) : (
              inboxSections.map((section) => (
                <div key={section.label}>
                  {/* 목업 ③: 날짜 section 라벨(calm·NOT uppercase) */}
                  <p className="px-3 pt-3 pb-1 text-[11.5px] font-medium text-muted-foreground">{section.label}</p>
                  {/* 목업 ④: dense rows — per-item 카드 테두리 제거·divide-y로 구분·content-dominant */}
                  <div className="divide-y divide-border/60">
                    {section.items.map((item) => {
                      // f2ec5395: status_changed 그룹 엔트리(접힘 default·chevron 토글·헤더클릭=내비+일괄읽음).
                      if (item.kind === 'group') {
                        const expanded = expandedGroups.has(item.key);
                        return (
                          <div key={`group-${item.key}`}>
                            <div className="relative flex items-stretch transition hover:bg-muted/40">
                              {/* story #2023 ⓑ: 미읽음=L5(시스템 상태), 브랜드 아님 */}
                              {item.hasUnread ? <span className="absolute left-0 top-0 h-full w-0.5 bg-info" aria-hidden /> : null}
                              <button
                                type="button"
                                onClick={() => toggleGroup(item.key)}
                                aria-expanded={expanded}
                                aria-label={expanded ? t('collapseHistory') : t('expandHistory')}
                                className="flex shrink-0 items-center px-2 text-muted-foreground transition hover:text-foreground"
                              >
                                {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => void openGroup(item)}
                                className="flex min-w-0 flex-1 items-start gap-3 py-2.5 pr-3 text-left"
                              >
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/6 text-muted-foreground">
                                  <NotifIcon type={item.latest.type} fallback={Bell} className="size-4" />
                                </div>
                                <div className="min-w-0 flex-1 space-y-0.5">
                                  <div className="flex items-start justify-between gap-2">
                                    {/* f2ec5395 fix: 카운트 칩을 truncate <p> 밖 shrink-0 형제로 — 긴 title 잘려도 칩 항상 표시 */}
                                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                      <p className={`min-w-0 truncate text-sm ${item.hasUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                                        {/* story #4281(까디르 P2) — 묶음 머리도 단일 행과 같은 표시 변환(`[종류]` · 기계 사유 원문 0). */}
                                        {composeNotificationDisplay(item.latest, t, eventPreviewHelpers).title}
                                      </p>
                                      {/* story #2023 ⓑ: 카운트 칩=L5(시스템 상태), 브랜드 아님 */}
                                      {/* story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙). */}
                                      {/* story #0d1c69f3(v2 4호) — generic 그룹은 status_change와 다른 문구(반복
                                          알림 건수일 뿐 "상태 변경" 의미가 아니다)를 쓴다. */}
                                      <span className="shrink-0 rounded-full border border-info/30 bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                                        {item.groupKind === 'status_change'
                                          ? t('statusChangeCount', { count: item.count })
                                          : t('notificationGroupCount', { count: item.count })}
                                      </span>
                                    </div>
                                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(item.latest.created_at)}</span>
                                  </div>
                                </div>
                              </button>
                            </div>
                            {expanded && item.groupKind === 'status_change' ? (
                              <div className="space-y-1.5 py-2 pl-9 pr-3">
                                {item.notifications.map((n, idx) => (
                                  <div key={n.id} className="flex items-center gap-2 text-xs">
                                    <span className={`size-1.5 shrink-0 rounded-full ${idx === 0 ? 'bg-success' : 'bg-muted-foreground/40'}`} />
                                    <span className="min-w-0 flex-1 truncate text-foreground">{composeNotificationDisplay(n, t, eventPreviewHelpers).title}</span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(n.created_at)}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {/* story #0d1c69f3(v2 4호) — generic 그룹 펼침: 항목별 구체 참조
                                (reference_type 라벨+reference_id 조각)+CTA(기존 href 재사용,
                                신규 데이터 0). href 없는 항목은 CTA를 안 그린다(갈 곳 없는
                                링크 금지 — 죽은 링크 0, AC2). */}
                            {expanded && item.groupKind === 'generic' ? (
                              <div className="space-y-1.5 py-2 pl-9 pr-3">
                                {item.notifications.map((n) => {
                                  const refLabel = referenceTypeLabel(t, n.reference_type);
                                  return (
                                    <div key={n.id} className="flex items-center gap-2 text-xs">
                                      {refLabel ? (
                                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                          {refLabel}
                                        </span>
                                      ) : null}
                                      {n.reference_id ? (
                                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
                                          {n.reference_id.slice(0, 8)}
                                        </span>
                                      ) : (
                                        <span className="min-w-0 flex-1 truncate text-foreground">{composeNotificationDisplay(n, t, eventPreviewHelpers).title}</span>
                                      )}
                                      <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(n.created_at)}</span>
                                      {n.href ? (
                                        <a
                                          href={n.href}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            void (async () => {
                                              if (!n.is_read) await setNotificationReadState(n.id, n.is_read, true);
                                              router.push(n.href!);
                                            })();
                                          }}
                                          className="shrink-0 font-semibold text-primary hover:underline"
                                        >
                                          {t('notificationOpenCta')}
                                        </a>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      }

                      const notification = item.notification;
                      const isSelected = notification.id === selectedId;
                      // ⓐ 도달 사유 칩(왜 내게) — 추론 가능할 때만, 없으면 생략(graceful degrade).
                      const reasonKey = getNotificationReasonKey(notification.type);
                      // story #3903 AC2 — 렌더 시점 title/body 조합(3888 eventCard 재사용).
                      const display = composeNotificationDisplay(notification, t, eventPreviewHelpers);
                      return (
                        <button
                          key={notification.id}
                          type="button"
                          onClick={() => void selectNotification(notification)}
                          className={`relative flex w-full items-start gap-3 px-3 py-2.5 text-left transition ${isSelected ? 'bg-accent' : 'hover:bg-muted/40'}`}
                        >
                          {/* 목업 ④: unread=좌측 accent strip(박시 카드 bg 대체). story #2023 ⓑ: L5(시스템 상태), 브랜드 아님 */}
                          {!notification.is_read ? <span className="absolute left-0 top-0 h-full w-0.5 bg-info" aria-hidden /> : null}
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/6 text-muted-foreground">
                            <NotifIcon type={notification.type} fallback={Info} className="size-4" />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className={`truncate text-sm ${notification.is_read ? 'text-muted-foreground' : 'font-semibold text-foreground'}`}>
                                {display.title}
                              </p>
                              <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(notification.created_at)}</span>
                            </div>
                            {display.body ? (
                              <p className="line-clamp-1 text-xs text-muted-foreground">{display.body}</p>
                            ) : null}
                            {/* 목업 ⑤: 타입 1급 — agent_joined=Bot 칩·도달사유 칩. story #3049
                                (2984-S1) — AgentIdentity 프리미티브(헤어라인+proof-blue 신호
                                dot) 채택, soft-fill 폐지. */}
                            {(notification.type === 'agent_joined' || reasonKey) ? (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {notification.type === 'agent_joined' ? <AgentIdentity /> : null}
                                {reasonKey ? <Badge variant="info" className="text-[10px]">{t(reasonKey)}</Badge> : null}
                              </div>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
            {/* story #2195 — hasMore가 참일 때만 노출(서버가 못 줄 때 서 있지 않게). */}
            {!loading && hasMore ? (
              <div className="px-3 py-3">
                <Button
                  variant="glass"
                  size="sm"
                  className="w-full"
                  disabled={loadingMore}
                  onClick={() => void loadMoreNotifications()}
                >
                  {tCommon('loadMore')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right: detail panel. max-lg: hidden when nothing selected (the list owns the
            screen); full-screen with a back button when an item is tapped (efcb3840 ⓑ, #1986). */}
        <div className={`focus-inset flex min-w-0 flex-1 flex-col overflow-y-auto ${!selectedId ? 'max-lg:hidden' : ''}`}>
          {selectedNotification ? (
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="flex shrink-0 items-center gap-1.5 border-b border-border/80 px-4 py-2.5 text-sm font-medium text-muted-foreground transition hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="size-4" />
              {t('backToList')}
            </button>
          ) : null}
          {selectedNotification ? (
            selectedNotification.type === 'agent_joined' ? (
              <AgentJoinedDetailPanel
                notification={selectedNotification}
                t={t}
                addToast={addToast}
                onRevoked={() => void refreshNotifications()}
              />
            ) : (
            <div className="flex flex-1 flex-col gap-4 px-6 py-6">
              <div className="flex items-start gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white/6 text-muted-foreground">
                  <NotifIcon type={selectedNotification.type} fallback={Info} className="size-5" />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{getInboxNotificationLabel(t, selectedNotification.type)}</Badge>
                    {getNotificationReasonKey(selectedNotification.type) ? (
                      <Badge variant="info">{t(getNotificationReasonKey(selectedNotification.type) as string)}</Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {t('receivedAt')} · {formatRelativeTime(selectedNotification.created_at, locale, displayTimezone)}
                    </span>
                  </div>
                  <h2 className="text-lg font-semibold text-foreground">{selectedDisplay?.title ?? selectedNotification.title}</h2>
                </div>
              </div>

              {selectedDisplay?.body ? (
                <div className="rounded-xl border border-white/8 bg-muted/55 p-4 text-sm leading-6 text-foreground whitespace-pre-wrap">
                  {selectedDisplay.body}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button
                  variant="glass"
                  size="sm"
                  onClick={() => void toggleRead(selectedNotification.id, selectedNotification.is_read)}
                >
                  {selectedNotification.is_read ? t('markUnread') : t('markRead')}
                </Button>
                {selectedNotification.href ? (
                  <Button
                    variant="hero"
                    size="sm"
                    onClick={() => void openNotification(selectedNotification)}
                  >
                    {t('open')}
                  </Button>
                ) : null}
              </div>
            </div>
            )
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <div className="flex size-14 items-center justify-center rounded-xl bg-muted/55">
                <InboxIcon className="size-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">{t('selectToView')}</p>
            </div>
          )}
        </div>
        </div>
        </>
        )}
      </div>

    </>
  );
}
