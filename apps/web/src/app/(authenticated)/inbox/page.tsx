'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { useToast, ToastContainer } from '@/components/ui/toast';
import {
  getInboxNotificationLabel,
  INBOX_FILTER_TYPES,
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
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const { toasts, addToast, dismissToast } = useToast();

  const refreshNotifications = useCallback(async () => {
    const result = await fetchInboxNotifications(typeFilter);
    if (!result) return;

    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
  }, [typeFilter]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const result = await fetchInboxNotifications(typeFilter);
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
  }, [typeFilter]);

  useEffect(() => {
    if (!currentTeamMemberId) return;
    const supabase = createSupabaseBrowserClient();
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

    return () => {
      supabase.removeChannel(channel);
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

  const openNotification = async (notification: Notification) => {
    if (!notification.href) {
      await toggleRead(notification.id, notification.is_read);
      return;
    }

    if (!notification.is_read) {
      await setNotificationReadState(notification.id, notification.is_read, true);
    }

    router.push(notification.href);
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

  return (
    <div className="space-y-4">
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {unreadCount > 0 ? <Badge variant="info">{unreadCount}</Badge> : null}
            <Button variant="glass" size="sm" onClick={markAllRead} disabled={unreadCount === 0}>
              {t('markAllRead')}
            </Button>
          </div>
        }
      />

      <SectionCard>
        <SectionCardHeader>
          <div className="flex flex-wrap gap-2">
            {INBOX_FILTER_TYPES.map((type) => {
              const active = typeFilter === type;
              const label = type ? `${NOTIFICATION_TYPE_ICONS[type] ?? '📋'} ${getInboxNotificationLabel(t, type)}` : t('filterAll');
              return (
                <Button
                  key={type || 'all'}
                  variant={active ? 'hero' : 'glass'}
                  size="sm"
                  onClick={() => setTypeFilter(type)}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <EmptyState title={t('noNotifications')} description={t('surfaceDescription')} />
          ) : (
            <div className="space-y-3">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={`rounded-2xl border p-4 transition hover:border-[color:var(--operator-primary)]/20 hover:bg-white/5 ${notification.is_read
                    ? 'border-white/8 bg-[color:var(--operator-surface-soft)]/55'
                    : 'border-[color:var(--operator-primary)]/18 bg-[color:var(--operator-primary)]/10'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => void openNotification(notification)}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-white/6 text-lg">
                        {NOTIFICATION_TYPE_ICONS[notification.type] ?? 'ℹ️'}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className={`text-sm ${notification.is_read ? 'text-[color:var(--operator-muted)]' : 'font-semibold text-[color:var(--operator-foreground)]'}`}>
                            {notification.title}
                          </p>
                          <div className="flex items-center gap-2">
                            <Badge variant={notification.is_read ? 'outline' : 'info'}>{getInboxNotificationLabel(t, notification.type)}</Badge>
                            <span className="text-xs text-[color:var(--operator-muted)]">{formatTime(notification.created_at)}</span>
                          </div>
                        </div>
                        {notification.body ? <p className="line-clamp-2 text-sm text-[color:var(--operator-muted)]">{notification.body}</p> : null}
                      </div>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {!notification.is_read ? <span className="mt-2 h-2.5 w-2.5 rounded-full bg-[color:var(--operator-primary)]" /> : null}
                      <Button
                        variant="glass"
                        size="sm"
                        onClick={() => void toggleRead(notification.id, notification.is_read)}
                      >
                        {notification.is_read ? t('markUnread') : t('markRead')}
                      </Button>
                      {notification.href ? (
                        <Button
                          variant="hero"
                          size="sm"
                          onClick={() => void openNotification(notification)}
                        >
                          {t('open')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCardBody>
      </SectionCard>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
