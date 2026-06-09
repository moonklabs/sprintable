'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Inbox as InboxIcon, Zap, ZapOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { DecisionsWaiting } from '@/components/inbox/decisions-waiting';
import { GateInbox } from '@/components/cage/gate-inbox';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { useToast, ToastContainer } from '@/components/ui/toast';
import {
  getInboxNotificationLabel,
  NOTIFICATION_TYPE_ICONS,
} from '@/services/notification-display';

interface WorkflowExecItem {
  id: string;
  event_type: string;
  trigger_type_slug: string | null;
  rule_name: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  is_read: boolean;
  reference_type: string | null;
  reference_id: string | null;
  href?: string | null;
  created_at: string;
}

// f2ec5395: 인박스 렌더 단위 — 개별 알림(single) 또는 같은 스토리 status_changed 그룹(group).
type InboxItem =
  | { kind: 'single'; notification: Notification; sortTime: number }
  | {
      kind: 'group';
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
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/6 text-xl">
          🤖
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t('filter_agent_joined')}</Badge>
            <span className="text-xs text-muted-foreground">
              {t('receivedAt')} · {new Date(notification.created_at).toLocaleString()}
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

async function fetchInboxNotifications(typeFilter: string) {
  const params = new URLSearchParams();
  if (typeFilter) params.set('type', typeFilter);

  const res = await fetch(`/api/notifications?${params}`);
  if (!res.ok) return null;

  const json = await res.json();
  return {
    notifications: (json.data ?? []) as Notification[],
    unreadCount: (json.meta?.unreadCount ?? 0) as number,
  };
}

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('inbox');
  const tCage = useTranslations('cage');
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const activeTab = searchParams.get('tab') ?? 'notifications';
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [workflowExecs, setWorkflowExecs] = useState<WorkflowExecItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { toasts, addToast, dismissToast } = useToast();

  const refreshNotifications = useCallback(async () => {
    const result = await fetchInboxNotifications('');
    if (!result) return;

    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const result = await fetchInboxNotifications('');
      if (!cancelled && result) {
        setNotifications(result.notifications);
        setUnreadCount(result.unreadCount);
      }
      if (!cancelled) setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentTeamMemberId || !projectId) return;
    const params = new URLSearchParams({ project_id: projectId, member_id: currentTeamMemberId, limit: '10' });
    fetch(`/api/workflow-executions?${params.toString()}`)
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

  const setNotificationReadState = async (id: string, currentIsRead: boolean, nextIsRead: boolean) => {
    if (currentIsRead === nextIsRead) return;

    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, is_read: nextIsRead }),
    });

    setNotifications((prev) => prev.map((notification) => (
      notification.id === id ? { ...notification, is_read: nextIsRead } : notification
    )));
    setUnreadCount((prev) => (nextIsRead ? Math.max(0, prev - 1) : prev + 1));
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
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    });
    setNotifications((prev) => prev.map((notification) => ({ ...notification, is_read: true })));
    setUnreadCount(0);
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t('justNow');
    if (diffMin < 60) return `${diffMin}${t('minutesAgo')}`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}${t('hoursAgo')}`;
    return d.toLocaleDateString();
  };

  const selectedNotification = useMemo(
    () => notifications.find((n) => n.id === selectedId) ?? null,
    [notifications, selectedId],
  );

  // f2ec5395: 같은 스토리 status_changed 알림을 reference_id로 그룹(2건+). 타 type·단건은 개별 유지.
  const inboxItems = useMemo<InboxItem[]>(() => {
    const groups = new Map<string, Notification[]>();
    const items: InboxItem[] = [];
    for (const n of notifications) {
      if (n.type === 'story_status_changed' && n.reference_id) {
        const arr = groups.get(n.reference_id) ?? [];
        arr.push(n);
        groups.set(n.reference_id, arr);
      } else {
        items.push({ kind: 'single', notification: n, sortTime: new Date(n.created_at).getTime() });
      }
    }
    for (const [key, arr] of groups) {
      const sorted = [...arr].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const latest = sorted[0]!;
      const sortTime = new Date(latest.created_at).getTime();
      if (sorted.length === 1) {
        // 단건이면 noise 아님 → 개별 엔트리(그룹 chevron/카운트 없음).
        items.push({ kind: 'single', notification: latest, sortTime });
      } else {
        items.push({
          kind: 'group', key, notifications: sorted, latest, count: sorted.length,
          hasUnread: sorted.some((n) => !n.is_read), sortTime,
        });
      }
    }
    return items.sort((a, b) => b.sortTime - a.sortTime);
  }, [notifications]);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => setExpandedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // 그룹 헤더 클릭 → 그룹 전체 읽음 + 스토리 이동(AC2).
  const openGroup = async (group: Extract<InboxItem, { kind: 'group' }>) => {
    const unread = group.notifications.filter((n) => !n.is_read);
    await Promise.all(unread.map((n) => setNotificationReadState(n.id, n.is_read, true)));
    if (group.latest.href) router.push(group.latest.href);
  };

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-medium">{t('title')}</h1>
            {unreadCount > 0 ? (
              <span className="text-sm tabular-nums text-muted-foreground">{unreadCount}</span>
            ) : null}
          </div>
        }
        actions={
          <Button variant="glass" size="sm" onClick={markAllRead} disabled={unreadCount === 0}>
            {t('markAllRead')}
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 탭 — 알림 / 게이트 */}
        <div className="flex shrink-0 border-b border-border/80 px-4">
          {([
            { key: 'notifications', label: t('title') },
            { key: 'gates', label: tCage('gateTabLabel') },
          ] as { key: string; label: string }[]).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => router.replace(`/inbox${key === 'notifications' ? '' : `?tab=${key}`}`, { scroll: false })}
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

        {activeTab === 'gates' ? (
          <div className="flex-1 overflow-y-auto p-4">
            {currentTeamMemberId ? (
              <GateInbox memberId={currentTeamMemberId} />
            ) : (
              <p className="text-xs text-muted-foreground">{t('loading')}</p>
            )}
          </div>
        ) : (
        <>
        <DecisionsWaiting onChange={() => void refreshNotifications()} />

        {workflowExecs.length > 0 && (
          <div className="shrink-0 border-b border-border/80 px-4 py-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">워크플로우 실행</p>
            <div className="flex flex-col gap-1.5">
              {workflowExecs.slice(0, 5).map((exec) => (
                <div key={exec.id} className="flex items-center gap-2 rounded-lg bg-muted/55 px-3 py-2 text-xs">
                  {exec.status === 'matched' ? (
                    <Zap className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  ) : (
                    <ZapOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {exec.rule_name ?? exec.event_type}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {exec.completed_at ? new Date(exec.completed_at).toLocaleString() : new Date(exec.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: notification list */}
        <div className="flex w-full max-w-[420px] min-w-[320px] flex-col border-r border-border/80">
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <p className="text-sm text-muted-foreground">{t('noNotifications')}</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {inboxItems.map((item) => {
                  // f2ec5395: status_changed 그룹 엔트리(접힘 default·chevron 토글·헤더클릭=내비+일괄읽음).
                  if (item.kind === 'group') {
                    const expanded = expandedGroups.has(item.key);
                    return (
                      <div
                        key={`group-${item.key}`}
                        className={`rounded-xl border ${item.hasUnread ? 'border-brand/18 bg-brand/8' : 'border-white/8 bg-muted/55'}`}
                      >
                        <div className="flex items-stretch">
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
                            className="flex min-w-0 flex-1 items-start gap-3 py-3 pr-3 text-left"
                          >
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/6 text-base">
                              {NOTIFICATION_TYPE_ICONS[item.latest.type] ?? '📌'}
                            </div>
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex items-start justify-between gap-2">
                                <p className={`min-w-0 flex-1 truncate text-sm ${item.hasUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                                  {item.latest.title}
                                  <span className="ml-1.5 inline-block rounded-full border border-brand/30 bg-brand/10 px-1.5 py-0.5 align-middle text-[10px] font-medium text-brand">
                                    {t('statusChangeCount', { count: item.count })}
                                  </span>
                                </p>
                                <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(item.latest.created_at)}</span>
                              </div>
                              {item.hasUnread ? (
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
                              ) : null}
                            </div>
                          </button>
                        </div>
                        {expanded ? (
                          <div className="space-y-1.5 border-t border-white/8 py-2 pl-9 pr-3">
                            {item.notifications.map((n, idx) => (
                              <div key={n.id} className="flex items-center gap-2 text-xs">
                                <span className={`size-1.5 shrink-0 rounded-full ${idx === 0 ? 'bg-success' : 'bg-muted-foreground/40'}`} />
                                <span className="min-w-0 flex-1 truncate text-foreground">{n.title}</span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(n.created_at)}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  }

                  const notification = item.notification;
                  const isSelected = notification.id === selectedId;
                  return (
                    <button
                      key={notification.id}
                      type="button"
                      onClick={() => void selectNotification(notification)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        isSelected
                          ? 'border-brand/35 bg-brand/15'
                          : notification.is_read
                            ? 'border-white/8 bg-muted/55 hover:border-brand/20 hover:bg-white/5'
                            : 'border-brand/18 bg-brand/8 hover:bg-brand/12'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/6 text-base">
                          {NOTIFICATION_TYPE_ICONS[notification.type] ?? 'ℹ️'}
                        </div>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`truncate text-sm ${notification.is_read ? 'text-muted-foreground' : 'font-semibold text-foreground'}`}>
                              {notification.title}
                            </p>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(notification.created_at)}</span>
                          </div>
                          {notification.body ? (
                            <p className="line-clamp-1 text-xs text-muted-foreground">{notification.body}</p>
                          ) : null}
                          {!notification.is_read ? (
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
                          ) : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: detail panel */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
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
                <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/6 text-xl">
                  {NOTIFICATION_TYPE_ICONS[selectedNotification.type] ?? 'ℹ️'}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{getInboxNotificationLabel(t, selectedNotification.type)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {t('receivedAt')} · {new Date(selectedNotification.created_at).toLocaleString()}
                    </span>
                  </div>
                  <h2 className="text-lg font-semibold text-foreground">{selectedNotification.title}</h2>
                </div>
              </div>

              {selectedNotification.body ? (
                <div className="rounded-xl border border-white/8 bg-muted/55 p-4 text-sm leading-6 text-foreground whitespace-pre-wrap">
                  {selectedNotification.body}
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
              <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/55">
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

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
