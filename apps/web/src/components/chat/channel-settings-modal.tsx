'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Avatar } from '@/components/ds/avatar';
import { Card } from '@/components/ds/card';
import { fetchWithAuth } from '@/lib/db/client';
import { extractBackendErrorMessage } from '@/lib/api-error-message';

// story 5032 (C2) — the channel's settings window (the cog of the channel's room head). One thing is new here: «이 채널의 모든 말 받기 — 에이전트마다». An agent of a group room receives only the words that call it (story 5030 · C0);
// this switch lets one agent of THIS channel read every word. It is the agent's own delivery level for the room (notification_preferences · scope conversation · channel sse): `all` = on, `mentions` = off (the default). No new API —
// the same `GET/PUT /api/notification-preferences` the room's delivery window uses (`member_id` = the agent: an organization owner / admin edits an agent's level; the server answers 403 to anyone else, so the list is drawn for owner / admin only).
// «내 알림 설정» (the person's own level for this room · the room-wide free-response switch) stays in the delivery window; a button here opens it.
export type ChannelAgent = { member_id: string; name: string | null; avatar_url?: string | null; runtime_type?: string | null };

interface PreferenceItem { scope_type: string; scope_id: string | null; channel: string; level: 'all' | 'mentions' | 'mute' }

const EDITED_CHANNEL = 'sse';

export interface ChannelSettingsModalProps {
  conversationId: string;
  /** the agents of the channel (its participants of type agent) — «부를 수 있는 에이전트» */
  agents: ChannelAgent[];
  /** only an organization owner / admin may read or change another member's level (the server's rule) */
  canEditAgents: boolean;
  /** the room-wide «free response» switch is ON (the room's delivery window): the delivery rule then lifts EVERY agent of the room from «only when called» to «every word» — a per-agent «off» would not take effect, so the switches are shown as on, locked, with a line saying why */
  roomFreeResponse?: boolean;
  onClose: () => void;
  /** opens the room's own delivery window («내 알림 설정») */
  onOpenMyNotifications: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

type RowState = { on: boolean; loading: boolean; saving: boolean; error: string | null; unreadable?: boolean };

export function ChannelSettingsModal({ conversationId, agents, canEditAgents, roomFreeResponse = false, onClose, onOpenMyNotifications, returnFocusRef }: ChannelSettingsModalProps) {
  const t = useTranslations('chats');
  const tc = useTranslations('common');
  const [rows, setRows] = useState<Record<string, RowState>>(() => Object.fromEntries(agents.map((a) => [a.member_id, { on: false, loading: canEditAgents, saving: false, error: null }])));

  const patch = useCallback((id: string, next: Partial<RowState>) => setRows((r) => ({ ...r, [id]: { ...(r[id] ?? { on: false, loading: false, saving: false, error: null }), ...next } })), []);

  // the agents as an id list: a parent that hands over a NEW array every render must not make this window read again (and overwrite a switch the person just changed)
  const agentIds = agents.map((a) => a.member_id);
  const agentKey = agentIds.join(',');
  const savingRef = useRef<Set<string>>(new Set());

  // read each agent's own level for this channel (one read per agent — a channel has a handful). A failed read is NOT «off»: the row stays locked and says it could not be read.
  useEffect(() => {
    if (!canEditAgents) return;
    let cancelled = false;
    for (const id of agentKey ? agentKey.split(',') : []) {
      fetchWithAuth(`/api/notification-preferences?member_id=${encodeURIComponent(id)}`)
        .then((r) => { if (!r.ok) throw new Error('read failed'); return r.json(); })
        .then((json: { data?: { data?: PreferenceItem[] } | PreferenceItem[] } | null) => {
          if (cancelled || savingRef.current.has(id)) return; // a switch being saved keeps the person's value, not the server's older one
          const list = !json ? [] : Array.isArray(json.data) ? json.data : (json.data as { data?: PreferenceItem[] } | undefined)?.data ?? [];
          const mine = list.find((p) => p.scope_type === 'conversation' && p.scope_id === conversationId && p.channel === EDITED_CHANNEL);
          patch(id, { on: mine?.level === 'all', loading: false, unreadable: false, error: null });
        })
        .catch(() => { if (!cancelled) patch(id, { loading: false, unreadable: true, error: t('channelSettingsLoadFailed') }); });
    }
    return () => { cancelled = true; };
  }, [agentKey, canEditAgents, conversationId, patch, t]);

  const toggle = async (agentId: string) => {
    const prev = rows[agentId]?.on ?? false;
    const next = !prev;
    savingRef.current.add(agentId);
    patch(agentId, { on: next, saving: true, error: null });
    try {
      const res = await fetchWithAuth('/api/notification-preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: [{ scope_type: 'conversation', scope_id: conversationId, channel: EDITED_CHANNEL, level: next ? 'all' : 'mentions' }],
          member_id: agentId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const backendMsg = extractBackendErrorMessage(body, t);
        patch(agentId, { on: prev, saving: false, error: backendMsg && res.status >= 400 && res.status < 500 ? backendMsg : t('channelSettingsSaveFailed') });
        return;
      }
      patch(agentId, { on: next, saving: false });
    } catch {
      patch(agentId, { on: prev, saving: false, error: t('channelSettingsSaveFailed') });
    } finally {
      savingRef.current.delete(agentId);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md overflow-hidden rounded-xl p-0" showCloseButton={false} finalFocus={returnFocusRef} data-testid="channel-settings">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-semibold text-foreground">{t('channelSettingsTitle')}</DialogTitle>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={tc('close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-4 py-3">
          <section aria-labelledby="channel-receive-all-h" data-testid="channel-receive-all">
            <h3 id="channel-receive-all-h" className="text-xs font-medium text-foreground">{t('channelReceiveAllTitle')}</h3>
            <p className="mt-1 text-editorial-meta text-muted-foreground">{t('channelReceiveAllHint')}</p>
            {canEditAgents && roomFreeResponse ? <p className="mt-1 text-editorial-meta text-foreground" data-testid="channel-receive-all-room-wide">{t('channelReceiveAllRoomWide')}</p> : null}
            {!canEditAgents ? (
              <p className="mt-2 text-editorial-meta text-muted-foreground" data-testid="channel-receive-all-admin-only">{t('channelReceiveAllAdminOnly')}</p>
            ) : agents.length === 0 ? (
              <p className="mt-2 text-editorial-meta text-muted-foreground" data-testid="channel-receive-all-empty">{t('channelReceiveAllNoAgents')}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {agents.map((a) => {
                  const row = rows[a.member_id] ?? { on: false, loading: true, saving: false, error: null };
                  const name = a.name?.trim() || t('agent');
                  return (
                    <li key={a.member_id} data-testid="channel-receive-all-row" data-agent-id={a.member_id}>
                      <Card className="px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <Avatar name={a.name ?? null} label={name} avatarUrl={a.avatar_url ?? null} actorType="agent" size={24} runtimeType={a.runtime_type ?? null} decorative />
                          <span className="min-w-0 truncate text-xs font-medium text-foreground">{name}</span>
                        </span>
                        <Switch
                          checked={row.on || roomFreeResponse}
                          disabled={row.loading || row.saving || row.unreadable || roomFreeResponse}
                          onCheckedChange={() => void toggle(a.member_id)}
                          aria-label={t('channelReceiveAllSwitch', { name })}
                        />
                      </div>
                      {row.on || roomFreeResponse ? <p className="mt-1 text-editorial-meta text-muted-foreground" data-testid="channel-receive-all-token-note">{t('channelReceiveAllTokenNote')}</p> : null}
                      {row.error ? <p role="alert" className="mt-1 text-xs text-destructive">{row.error}</p> : null}
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="border-t border-border pt-3">
            <Button variant="outline" size="sm" onClick={onOpenMyNotifications} data-testid="channel-open-my-notifications">{t('channelMyNotifications')}</Button>
          </div>
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>{tc('close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
