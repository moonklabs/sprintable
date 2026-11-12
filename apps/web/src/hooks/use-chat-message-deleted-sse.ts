import { useEffect, useRef } from 'react';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { announceChatMessageDeleted, parseMessageDeletedFrame } from '@/lib/chat-message-deleted';
import { createSeenIdTracker, shouldSuppressDuplicateSseEvent } from '@/lib/realtime/sse-event-dedup';

/**
 * story 4903 AC3 — another person deleted a message: the server's `conversation.message_deleted` frame (ids and moments only) becomes the local «message deleted» announcement,
 * which the open room, its thread panel and the room LIST each listen to (they turn it into a tombstone / a blank preview without a reload).
 *
 * Mounted ONCE, by the chats layout (the one place that mounts the list and its outlet) — not per component, so a frame is parsed and announced once per tab.
 */
export function useChatMessageDeletedSse(): void {
  const mux = useSseMultiplexerContext();
  // this hook's own dedup tracker (not a module global): the frame is a transient one (no DB Event row) — the live loop stamps a stable `event_id` on it, so a copy from the stream's
  // replay buffer after a reconnect and the live copy are one frame here (story #2163 — the same rule as every other SSE handler)
  const seenIdsRef = useRef(createSeenIdTracker());
  useEffect(() => {
    if (!mux) return;
    return mux.subscribe('conversation.message_deleted', (raw: string) => {
      if (shouldSuppressDuplicateSseEvent(raw, seenIdsRef.current)) return;
      const detail = parseMessageDeletedFrame(raw);
      if (detail) announceChatMessageDeleted(detail);
    });
  }, [mux]);
}
