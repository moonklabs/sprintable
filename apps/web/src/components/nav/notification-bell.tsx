'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  BookOpen,
  CheckCheck,
  FolderKanban,
  MessageSquareMore,
  X,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useSseNotifications, type SseEventNotification } from '@/hooks/use-sse-notifications';

type FilterTab = 'all' | 'memo' | 'story' | 'system';

const FILTER_TABS: { value: FilterTab; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'memo', label: '메모' },
  { value: 'story', label: '스토리' },
  { value: 'system', label: '시스템' },
];

function getNotificationTab(eventType: string): 'memo' | 'story' | 'system' {
  if (eventType.startsWith('memo')) return 'memo';
  if (
    eventType.startsWith('story') ||
    eventType.startsWith('task') ||
    eventType === 'dispatched'
  )
    return 'story';
  return 'system';
}

interface EventNotification {
  id: string;
  event_type: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  payload: {
    summary?: string;
    sender_name?: string;
    slug?: string;
    [key: string]: unknown;
  } | null;
  read_at: string | null;
  created_at: string;
}

function getEntityHref(notification: EventNotification): string | null {
  const { source_entity_type, source_entity_id } = notification;
  if (!source_entity_id) return null;
  switch (source_entity_type) {
    case 'memo':
      return `/memos?id=${source_entity_id}`;
    case 'story':
      return `/board?story=${source_entity_id}`;
    case 'task':
      return `/board?task_id=${source_entity_id}`;
    case 'epic':
      return `/epics/${source_entity_id}`;
    case 'sprint':
      // sprints-client.tsx에서 id 파라미터 처리 추가됨
      return `/sprints?id=${source_entity_id}`;
    case 'doc': {
      // docs-shell-client.tsx는 slug 파라미터 사용. payload에 slug가 있으면 deep link
      const slug = notification.payload?.slug as string | undefined;
      return slug ? `/docs?slug=${slug}` : `/docs`;
    }
    default:
      return null;
  }
}

function getEventIcon(eventType: string) {
  if (eventType.startsWith('memo')) return <MessageSquareMore className="size-4" />;
  if (eventType.startsWith('story') || eventType.startsWith('status')) return <FolderKanban className="size-4" />;
  if (eventType === 'dispatched') return <Zap className="size-4" />;
  if (eventType.startsWith('doc')) return <BookOpen className="size-4" />;
  return <Bell className="size-4" />;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

async function fetchNotifications(projectId?: string): Promise<EventNotification[]> {
  const params = new URLSearchParams({ limit: '30' });
  if (projectId) params.set('project_id', projectId);
  const res = await fetch(`/api/event-notifications?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as unknown;
  if (Array.isArray(json)) return json as EventNotification[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj['data'])) return obj['data'] as EventNotification[];
    if (obj['items'] && Array.isArray(obj['items'])) return obj['items'] as EventNotification[];
  }
  return [];
}

async function fetchUnreadCount(projectId?: string): Promise<number> {
  const params = projectId ? `?project_id=${projectId}` : '';
  const res = await fetch(`/api/event-notifications/unread-count${params}`);
  if (!res.ok) return 0;
  const json = (await res.json()) as unknown;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    if (typeof obj['count'] === 'number') return obj['count'];
    if (typeof obj['unread_count'] === 'number') return obj['unread_count'];
    if (obj['data'] && typeof obj['data'] === 'object') {
      const data = obj['data'] as Record<string, unknown>;
      if (typeof data['count'] === 'number') return data['count'];
    }
  }
  return 0;
}

interface NotificationPanelProps {
  notifications: EventNotification[] | null;
  onMarkAllRead: () => void;
  onNavigate: (notification: EventNotification) => void;
  onClose: () => void;
}

function NotificationPanel({
  notifications,
  onMarkAllRead,
  onNavigate,
  onClose,
}: NotificationPanelProps) {
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  const loading = notifications === null;
  const hasUnread = notifications?.some((n) => !n.read_at) ?? false;

  const filtered = notifications?.filter((n) => {
    if (showUnreadOnly && n.read_at) return false;
    if (filterTab !== 'all') return getNotificationTab(n.event_type) === filterTab;
    return true;
  }) ?? [];

  const emptyMessage =
    filterTab === 'memo' ? '메모 알림이 없습니다' :
    filterTab === 'story' ? '스토리 알림이 없습니다' :
    filterTab === 'system' ? '시스템 알림이 없습니다' :
    '새 알림이 없습니다';

  return (
    <div className="flex h-full flex-col">
      {/* 헤더 */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold">알림</span>
        <div className="flex items-center gap-1">
          {hasUnread && (
            <button
              type="button"
              onClick={onMarkAllRead}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <CheckCheck className="size-3.5" />
              전체 읽음
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="닫기"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* 필터 탭 */}
      <div className="flex shrink-0 overflow-x-auto border-b">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setFilterTab(tab.value)}
            className={cn(
              'shrink-0 px-3 py-2 text-xs font-medium transition',
              filterTab === tab.value
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
        <div className="ml-auto flex shrink-0 items-center px-3">
          <button
            type="button"
            onClick={() => setShowUnreadOnly((v) => !v)}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition',
              showUnreadOnly
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            안읽음만
          </button>
        </div>
      </div>

      {/* 목록 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            로딩 중…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Bell className="size-8 opacity-30" />
            <span>{emptyMessage}</span>
          </div>
        ) : (
          <ul>
            {filtered.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(n)}
                  className={cn(
                    'flex w-full gap-3 px-4 py-3 text-left transition hover:bg-accent',
                    !n.read_at && 'bg-primary/5',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 rounded-full p-1.5',
                      n.read_at
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-primary/10 text-primary',
                    )}
                  >
                    {getEventIcon(n.event_type)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'truncate text-sm',
                        !n.read_at && 'font-medium',
                      )}
                    >
                      {n.payload?.summary ?? n.event_type}
                    </p>
                    {n.payload?.sender_name ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {n.payload.sender_name}
                      </p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {timeAgo(n.created_at)}
                    </p>
                  </div>
                  {!n.read_at && (
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function NotificationBell() {
  const router = useRouter();
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // null = 로딩 중, array = 로드 완료
  const [notifications, setNotifications] = useState<EventNotification[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // SSE 실시간 알림 수신
  const handleSseNotification = useCallback((incoming: SseEventNotification) => {
    // unread count 즉시 증가
    setUnreadCount((c) => c + 1);
    // 패널 열린 상태면 목록 맨 앞에 추가
    setNotifications((prev) => {
      if (prev === null) return prev;
      const notification: EventNotification = {
        id: incoming.id ?? crypto.randomUUID(),
        event_type: incoming.event_type,
        source_entity_type: incoming.source_entity_type,
        source_entity_id: incoming.source_entity_id,
        payload: incoming.payload,
        read_at: null,
        created_at: incoming.created_at,
      };
      return [notification, ...prev];
    });
    // 탭 비활성 상태에서 브라우저 알림 표시
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      void new Notification(incoming.payload?.summary ?? incoming.event_type, {
        body: incoming.payload?.sender_name ?? undefined,
        icon: '/favicon.ico',
      });
    }
  }, []);

  useSseNotifications({ onNotification: handleSseNotification, memberId: currentTeamMemberId });

  // unread count 폴링 (30초 — SSE 실패 보완)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const count = await fetchUnreadCount(projectId ?? undefined);
      if (!cancelled) setUnreadCount(count);
    };
    void poll();
    intervalRef.current = setInterval(() => { void poll(); }, 30_000);
    const onVisibility = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectId]);

  // 패널 열릴 때 알림 목록 로드 + 브라우저 Notification 권한 요청
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchNotifications(projectId ?? undefined).then((data) => {
      if (!cancelled) setNotifications(data);
    });
    // 브라우저 Notification 권한 — 최초 패널 오픈 시 요청
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    return () => { cancelled = true; };
  }, [open, projectId]);

  // 외부 클릭으로 패널 닫기 (데스크톱)
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const handleMarkRead = useCallback(async (id: string) => {
    const readAt = new Date().toISOString();
    // 낙관적 업데이트
    setNotifications((prev) =>
      prev ? prev.map((n) => (n.id === id ? { ...n, read_at: readAt } : n)) : prev,
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    const res = await fetch(`/api/event-notifications/${id}/read`, { method: 'PATCH' });
    // 서버 실패 시 롤백
    if (!res.ok) {
      setNotifications((prev) =>
        prev ? prev.map((n) => (n.id === id ? { ...n, read_at: null } : n)) : prev,
      );
      setUnreadCount((c) => c + 1);
    }
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    const readAt = new Date().toISOString();
    // 낙관적 업데이트
    setNotifications((prev) => prev ? prev.map((n) => ({ ...n, read_at: n.read_at ?? readAt })) : prev);
    setUnreadCount(0);
    const res = await fetch('/api/event-notifications/read-all', { method: 'PATCH' });
    // 서버 실패 시 unread count 재폴링으로 보정
    if (!res.ok) {
      void fetchUnreadCount(projectId ?? undefined).then(setUnreadCount);
    }
  }, [projectId]);

  const handleNavigate = useCallback(
    (notification: EventNotification) => {
      if (!notification.read_at) void handleMarkRead(notification.id);
      const href = getEntityHref(notification);
      setOpen(false);
      if (href) router.push(href);
    },
    [handleMarkRead, router],
  );

  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount);

  return (
    <div ref={containerRef} className="relative">
      {/* 벨 버튼 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `알림 ${badgeLabel}개` : '알림'}
        aria-expanded={open}
        className="relative flex size-8 items-center justify-center rounded-md text-foreground/70 transition hover:bg-accent hover:text-foreground"
      >
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 py-px font-mono text-[9px] font-bold leading-none text-destructive-foreground">
            {badgeLabel}
          </span>
        )}
      </button>

      {/* 데스크톱 드롭다운 (lg+) */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 hidden w-80 overflow-hidden rounded-lg border bg-background shadow-lg lg:flex lg:flex-col" style={{ maxHeight: '480px' }}>
          <NotificationPanel
            notifications={notifications}
            onMarkAllRead={handleMarkAllRead}
            onNavigate={handleNavigate}
            onClose={() => setOpen(false)}
          />
        </div>
      )}

      {/* 모바일 풀스크린 오버레이 (< lg) */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background lg:hidden">
          <NotificationPanel
            notifications={notifications}
            onMarkAllRead={handleMarkAllRead}
            onNavigate={handleNavigate}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
