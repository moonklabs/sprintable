'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

interface MemoPresenceEntry {
  user_id: string;
  name: string;
  typing: boolean;
  state: 'viewing' | 'typing';
  updated_at: string;
}

interface MemoPresenceState {
  connected: boolean;
  viewers: MemoPresenceEntry[];
  typingUsers: MemoPresenceEntry[];
}

interface UseMemoPresenceOptions {
  memoId?: string;
  currentTeamMemberId?: string;
  currentTeamMemberName?: string;
  enabled?: boolean;
}

function collapsePresence(entries: MemoPresenceEntry[], currentTeamMemberId?: string) {
  const map = new Map<string, MemoPresenceEntry>();
  for (const entry of entries) {
    if (currentTeamMemberId && entry.user_id === currentTeamMemberId) continue;
    const existing = map.get(entry.user_id);
    if (!existing) {
      map.set(entry.user_id, entry);
      continue;
    }

    const existingStamp = Date.parse(existing.updated_at) || 0;
    const nextStamp = Date.parse(entry.updated_at) || 0;
    if (entry.typing && !existing.typing) {
      map.set(entry.user_id, entry);
      continue;
    }
    if (nextStamp >= existingStamp) {
      map.set(entry.user_id, entry);
    }
  }
  return [...map.values()];
}

function makePresenceEntry(userId: string, name: string, typing: boolean): MemoPresenceEntry {
  return {
    user_id: userId,
    name,
    typing,
    state: typing ? 'typing' : 'viewing',
    updated_at: new Date().toISOString(),
  };
}

export function useMemoPresence({ memoId, currentTeamMemberId, currentTeamMemberName, enabled = true }: UseMemoPresenceOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<MemoPresenceState>({
    connected: false,
    viewers: [],
    typingUsers: [],
  });

  const syncFromChannel = useCallback(() => {
    const channel = channelRef.current;
    if (!channel) return;
    const rawState = channel.presenceState() as Record<string, MemoPresenceEntry[]>;
    const entries = Object.values(rawState).flat();
    const peers = collapsePresence(entries, currentTeamMemberId);
    setState({
      connected: true,
      viewers: peers.filter((entry) => !entry.typing),
      typingUsers: peers.filter((entry) => entry.typing),
    });
  }, [currentTeamMemberId]);

  const setTyping = useCallback(async (typing: boolean) => {
    const channel = channelRef.current;
    if (!channel || !memoId || !currentTeamMemberId || !enabled) return;
    await channel.track(makePresenceEntry(currentTeamMemberId, currentTeamMemberName ?? currentTeamMemberId, typing)).catch(() => {});
    syncFromChannel();
  }, [currentTeamMemberId, currentTeamMemberName, enabled, memoId, syncFromChannel]);

  useEffect(() => {
    if (!enabled || !memoId || !currentTeamMemberId || process.env['NEXT_PUBLIC_OSS_MODE'] === 'true') {
      const resetTimer = setTimeout(() => {
        setState({ connected: false, viewers: [], typingUsers: [] });
      }, 0);
      return () => clearTimeout(resetTimer);
    }

    let cancelled = false;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase.channel(`memo-collab:${memoId}`);
    channelRef.current = channel;

    channel
      .on('presence', { event: 'sync' }, syncFromChannel)
      .on('presence', { event: 'join' }, syncFromChannel)
      .on('presence', { event: 'leave' }, syncFromChannel)
      .subscribe((status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          setState((prev) => ({ ...prev, connected: true }));
          channel.track(makePresenceEntry(currentTeamMemberId, currentTeamMemberName ?? currentTeamMemberId, false)).catch(() => {});
          syncFromChannel();
        } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
          setState((prev) => ({ ...prev, connected: false }));
        }
      });

    return () => {
      cancelled = true;
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
      if (channelRef.current) {
        channelRef.current.untrack().catch(() => {});
        supabase.removeChannel(channelRef.current).catch(() => {});
      }
      channelRef.current = null;
    };
  }, [currentTeamMemberId, currentTeamMemberName, enabled, memoId, syncFromChannel]);

  const queueTyping = useCallback((typing: boolean) => {
    if (!enabled || !memoId || !currentTeamMemberId) return;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (!typing) {
      setTyping(false).catch(() => {});
      return;
    }
    setTyping(true).catch(() => {});
    typingTimerRef.current = setTimeout(() => {
      setTyping(false).catch(() => {});
    }, 1200);
  }, [currentTeamMemberId, enabled, memoId, setTyping]);

  return useMemo(() => ({
    connected: state.connected,
    viewers: state.viewers,
    typingUsers: state.typingUsers,
    setTyping: queueTyping,
  }), [queueTyping, state.connected, state.typingUsers, state.viewers]);
}
