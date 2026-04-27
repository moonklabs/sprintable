'use client';

import { useEffect, useRef, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

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

export function useRealtimeMemos({ currentTeamMemberId, onNewMemo, onNewReply, onMemoUpdated }: UseRealtimeMemosOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onNewMemoRef = useRef(onNewMemo);
  const onNewReplyRef = useRef(onNewReply);
  const onMemoUpdatedRef = useRef(onMemoUpdated);
  const currentTeamMemberIdRef = useRef(currentTeamMemberId);

  useEffect(() => { onNewMemoRef.current = onNewMemo; }, [onNewMemo]);
  useEffect(() => { onNewReplyRef.current = onNewReply; }, [onNewReply]);
  useEffect(() => { onMemoUpdatedRef.current = onMemoUpdated; }, [onMemoUpdated]);
  useEffect(() => { currentTeamMemberIdRef.current = currentTeamMemberId; }, [currentTeamMemberId]);

  useEffect(() => {
    if (process.env['NEXT_PUBLIC_OSS_MODE'] === 'true') return;
let supabase: ReturnType<typeof createSupabaseBrowserClient>;
try {
supabase = createSupabaseBrowserClient();
} catch (err) {
console.error('[Realtime] Failed to create Supabase client:', err);
return;
}

    async function subscribe() {
      if (channelRef.current) {
        await supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      const channel = supabase
        .channel('memos-realtime')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'memos' }, (payload) => {
          const memo = payload.new as RealtimeMemo;
          const isAssignedToMe = Boolean(currentTeamMemberIdRef.current && memo.assigned_to === currentTeamMemberIdRef.current);
          onNewMemoRef.current?.(memo, isAssignedToMe);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'memos' }, (payload) => {
          onMemoUpdatedRef.current?.(payload.new as RealtimeMemo);
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'memo_replies' }, (payload) => {
          onNewReplyRef.current?.(payload.new as RealtimeReply);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setConnected(true);
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
            setConnected(false);
            if (!reconnectTimerRef.current) {
              reconnectTimerRef.current = setTimeout(() => {
                reconnectTimerRef.current = null;
                subscribe().catch((err) => console.error('[Realtime] reconnect error:', err));
              }, 5000);
            }
          }
        });

      channelRef.current = channel;
    }

    subscribe().catch((err) => {
      console.error('[Realtime] subscribe error:', err);
    });

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  return { connected };
}
