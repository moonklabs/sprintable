'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Inbox as InboxIcon } from 'lucide-react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { DecisionsWaiting } from '@/components/inbox/decisions-waiting';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { useToast, ToastContainer } from '@/components/ui/toast';
import {
  getInboxNotificationLabel,
  NOTIFICATION_TYPE_ICONS,
} from '@/services/notification-display';

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
  const t = useTranslations('inbox');
  const { currentTeamMemberId } = useDashboardContext();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
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
    if (!currentTeamMemberId) return;

    const ossMode = process.env.NEXT_PUBLIC_OSS_MODE === 'true';
    const hasSupabaseEnv =
      !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    // OSS or missing Supabase config: fall back to polling the existing inbox API
    if (ossMode || !hasSupabaseEnv) {
      const interval = setInterval(() => {
        void refreshNotifications();
      }, 15000);
      return () => clearInterval(interval);
    }

    // Supabase realtime path (cloud mode)
    let cleanupFn: (() => void) | undefined;

    (async () => {
      let supabase: ReturnType<typeof createSupabaseBrowserClient>;
      try {
        supabase = createSupabaseBrowserClient();
      } catch {
        const interval = setInterval(() => {
          void refreshNotifications();
        }, 15000);
        cleanupFn = () => clearInterval(interval);
        return;
      }

      const channel = supabase
      .channel('inbox-realtime')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${currentTeamMemberId}`,
      }, (payload) => {
        const newNotif = payload.new as Notification;
        addToast({
          title: `${NOTIFICATION_TYPE_ICONS[newNotif.type] ?? 'ℹ️'} ${newNotif.title}`,
          body: newNotif.body?.slice(0, 60) ?? '',
          type: 'info',
        });
        void refreshNotifications();
      })
      .subscribe();

      cleanupFn = () => {
        supabase.removeChannel(channel);
      };
    })();

    return () => {
      cleanupFn?.();
    };
  }, [currentTeamMemberId, addToast, refreshNotifications]);

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

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-medium">{t('title')}</h1>
            {unreadCount > 0 ? (
              <span className="text-sm tabular-nums text-[color:var(--operator-muted)]">{unreadCount}</span>
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
        <DecisionsWaiting onChange={() => void refreshNotifications()} />

        <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: notification list */}
        <div className="flex w-full max-w-[420px] min-w-[320px] flex-col border-r border-border/80">
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-xl bg-[color:var(--operator-surface-soft)]" />
                ))}
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <p className="text-sm text-[color:var(--operator-muted)]">{t('noNotifications')}</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {notifications.map((notification) => {
                  const isSelected = notification.id === selectedId;
                  return (
                    <button
                      key={notification.id}
                      type="button"
                      onClick={() => void selectNotification(notification)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        isSelected
                          ? 'border-[color:var(--operator-primary)]/35 bg-[color:var(--operator-primary)]/15'
                          : notification.is_read
                            ? 'border-white/8 bg-[color:var(--operator-surface-soft)]/55 hover:border-[color:var(--operator-primary)]/20 hover:bg-white/5'
                            : 'border-[color:var(--operator-primary)]/18 bg-[color:var(--operator-primary)]/8 hover:bg-[color:var(--operator-primary)]/12'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/6 text-base">
                          {NOTIFICATION_TYPE_ICONS[notification.type] ?? 'ℹ️'}
                        </div>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`truncate text-sm ${notification.is_read ? 'text-[color:var(--operator-muted)]' : 'font-semibold text-[color:var(--operator-foreground)]'}`}>
                              {notification.title}
                            </p>
                            <span className="shrink-0 text-[11px] text-[color:var(--operator-muted)]">{formatTime(notification.created_at)}</span>
                          </div>
                          {notification.body ? (
                            <p className="line-clamp-1 text-xs text-[color:var(--operator-muted)]">{notification.body}</p>
                          ) : null}
                          {!notification.is_read ? (
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--operator-primary)]" />
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
            <div className="flex flex-1 flex-col gap-4 px-6 py-6">
              <div className="flex items-start gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/6 text-xl">
                  {NOTIFICATION_TYPE_ICONS[selectedNotification.type] ?? 'ℹ️'}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{getInboxNotificationLabel(t, selectedNotification.type)}</Badge>
                    <span className="text-xs text-[color:var(--operator-muted)]">
                      {t('receivedAt')} · {new Date(selectedNotification.created_at).toLocaleString()}
                    </span>
                  </div>
                  <h2 className="text-lg font-semibold text-[color:var(--operator-foreground)]">{selectedNotification.title}</h2>
                </div>
              </div>

              {selectedNotification.body ? (
                <div className="rounded-xl border border-white/8 bg-[color:var(--operator-surface-soft)]/55 p-4 text-sm leading-6 text-[color:var(--operator-foreground)] whitespace-pre-wrap">
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
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-[color:var(--operator-surface-soft)]/55">
                <InboxIcon className="size-6 text-[color:var(--operator-muted)]" />
              </div>
              <p className="text-sm font-medium text-[color:var(--operator-muted)]">{t('selectToView')}</p>
            </div>
          )}
        </div>
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
