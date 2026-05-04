'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface MemoPresenceEntry {
  user_id: string;
  name: string;
  typing: boolean;
  state: 'viewing' | 'typing';
  updated_at: string | number;
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

const HEARTBEAT_INTERVAL_MS = 25_000;
const POLL_INTERVAL_MS = 15_000;

export function useMemoPresence({ memoId, currentTeamMemberId, currentTeamMemberName, enabled = true }: UseMemoPresenceOptions) {
  const [state, setState] = useState<MemoPresenceState>({ connected: false, viewers: [], typingUsers: [] });
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingRef = useRef(false);

  const sendPresence = useCallback(async (typing: boolean) => {
    if (!memoId || !currentTeamMemberId || !enabled) return;
    try {
      await fetch(`/api/v2/memos/${memoId}/presence?typing=${typing}&name=${encodeURIComponent(currentTeamMemberName ?? currentTeamMemberId)}`, { method: 'POST' });
    } catch { /* ignore */ }
  }, [memoId, currentTeamMemberId, currentTeamMemberName, enabled]);

  const fetchViewers = useCallback(async () => {
    if (!memoId || !currentTeamMemberId || !enabled) return;
    try {
      const res = await fetch(`/api/v2/memos/${memoId}/presence`);
      if (!res.ok) return;
      const json = await res.json() as { data?: MemoPresenceEntry[] };
      const entries = json.data ?? [];
      setState({
        connected: true,
        viewers: entries.filter((e) => !e.typing),
        typingUsers: entries.filter((e) => e.typing),
      });
    } catch { setState((prev) => ({ ...prev, connected: false })); }
  }, [memoId, currentTeamMemberId, enabled]);

  useEffect(() => {
    if (!enabled || !memoId || !currentTeamMemberId || process.env['NEXT_PUBLIC_OSS_MODE'] === 'true') {
      setState({ connected: false, viewers: [], typingUsers: [] });
      return;
    }

    // 초기 presence + 폴링
    sendPresence(false);
    fetchViewers();

    heartbeatRef.current = setInterval(() => sendPresence(typingRef.current), HEARTBEAT_INTERVAL_MS);
    pollRef.current = setInterval(fetchViewers, POLL_INTERVAL_MS);

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [memoId, currentTeamMemberId, enabled, sendPresence, fetchViewers]);

  const queueTyping = useCallback((typing: boolean) => {
    if (!enabled || !memoId || !currentTeamMemberId) return;
    typingRef.current = typing;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    sendPresence(typing).catch(() => {});
    if (typing) {
      typingTimerRef.current = setTimeout(() => {
        typingRef.current = false;
        sendPresence(false).catch(() => {});
      }, 1200);
    }
  }, [currentTeamMemberId, enabled, memoId, sendPresence]);

  return useMemo(() => ({
    connected: state.connected,
    viewers: state.viewers,
    typingUsers: state.typingUsers,
    setTyping: queueTyping,
  }), [queueTyping, state.connected, state.typingUsers, state.viewers]);
}
