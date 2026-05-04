'use client';

import { useEffect, useRef, useState } from 'react';

interface RealtimeMemo {
  id: string;
  title: string | null;
  content: string;
  assigned_to: string | null;
  created_by: string;
  memo_type: string;
  status?: string;
  updated_at?: string;
}

interface RealtimeReply {
  id: string;
  memo_id: string;
  created_by: string | null;
  created_at: string;
}

interface UseRealtimeMemosOptions {
  currentTeamMemberId?: string;
  onNewMemo?: (memo: RealtimeMemo, isAssignedToMe: boolean) => void;
  onNewReply?: (reply: RealtimeReply) => void;
  onMemoUpdated?: (memo: RealtimeMemo) => void;
}

const RECONNECT_DELAYS_MS = [5_000, 30_000, 60_000, 300_000];

export function useRealtimeMemos({ currentTeamMemberId, onNewMemo, onNewReply, onMemoUpdated }: UseRealtimeMemosOptions) {
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const onNewMemoRef = useRef(onNewMemo);
  const onNewReplyRef = useRef(onNewReply);
  const onMemoUpdatedRef = useRef(onMemoUpdated);
  const currentTeamMemberIdRef = useRef(currentTeamMemberId);

  useEffect(() => { onNewMemoRef.current = onNewMemo; }, [onNewMemo]);
  useEffect(() => { onNewReplyRef.current = onNewReply; }, [onNewReply]);
  useEffect(() => { onMemoUpdatedRef.current = onMemoUpdated; }, [onMemoUpdated]);
  useEffect(() => { currentTeamMemberIdRef.current = currentTeamMemberId; }, [currentTeamMemberId]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    function connect() {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }

      const url = new URL('/api/v2/events/memos', window.location.origin);
      if (currentTeamMemberIdRef.current) url.searchParams.set('member_id', currentTeamMemberIdRef.current);

      const source = new EventSource(url.toString());
      sourceRef.current = source;

      source.onopen = () => {
        setConnected(true);
        reconnectAttemptsRef.current = 0;
      };

      source.onerror = () => {
        setConnected(false);
        source.close();
        sourceRef.current = null;
        if (!reconnectTimerRef.current) {
          const attempts = reconnectAttemptsRef.current;
          const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)];
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, delay);
        }
      };

      source.addEventListener('memo_created', (e: MessageEvent) => {
        try {
          const memo = JSON.parse(e.data) as RealtimeMemo;
          const isAssignedToMe = Boolean(currentTeamMemberIdRef.current && memo.assigned_to === currentTeamMemberIdRef.current);
          onNewMemoRef.current?.(memo, isAssignedToMe);
        } catch { /* ignore parse errors */ }
      });

      source.addEventListener('memo_updated', (e: MessageEvent) => {
        try {
          onMemoUpdatedRef.current?.(JSON.parse(e.data) as RealtimeMemo);
        } catch { /* ignore parse errors */ }
      });

      source.addEventListener('reply_created', (e: MessageEvent) => {
        try {
          onNewReplyRef.current?.(JSON.parse(e.data) as RealtimeReply);
        } catch { /* ignore parse errors */ }
      });
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (sourceRef.current) sourceRef.current.close();
      sourceRef.current = null;
    };
  }, []);

  return { connected };
}
