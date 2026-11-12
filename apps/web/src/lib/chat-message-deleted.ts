/**
 * story 4887 (UI-4) — «a message was deleted» as a window event between the places that hold copies of the conversation's latest message.
 * The room (ChatView) and its thread panel delete a message; the room LIST (ChatListView, another component tree) keeps the latest message of each room as a one-line preview — and kept showing a deleted message's text
 * until its next refetch. The server scrubs it on refetch (content «» · no attachment flag); this event lets the list do the same at once. The list's latest-message record has no id, so the event carries the message's `created_at`.
 * Two sources: this screen's own delete (the room · the thread panel announce it) and — story 4903 AC3 — the server's `conversation.message_deleted` frame (another person's delete; `useChatMessageDeletedSse`).
 */
export const CHAT_MESSAGE_DELETED_EVENT = 'sprintable:chat-message-deleted';

export interface ChatMessageDeletedDetail {
  conversationId: string;
  /** the deleted message's `created_at`, as the server sent it */
  createdAt: string;
  /** story 4903 AC3 — present when the announcement came from the SERVER (`conversation.message_deleted`: another person deleted it): which message, in which thread, when.
   *  A delete made on THIS screen (the room · the thread panel) has already tombstoned its own copies and announces only the two fields above. */
  messageId?: string;
  threadId?: string | null;
  deletedAt?: string | null;
}

/**
 * story 4903 AC3 — the server's `conversation.message_deleted` frame (ids and moments only — never words) as a bus announcement; null when it is not one.
 * The frame: `{ event_type, conversation_id, id, thread_id, created_at, deleted_at, recipient_id }`.
 */
export function parseMessageDeletedFrame(raw: string | Record<string, unknown>): ChatMessageDeletedDetail | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  const f = data as Record<string, unknown>;
  if (typeof f.conversation_id !== 'string' || typeof f.id !== 'string' || typeof f.created_at !== 'string') return null;
  return {
    conversationId: f.conversation_id,
    createdAt: f.created_at,
    messageId: f.id,
    threadId: typeof f.thread_id === 'string' ? f.thread_id : null,
    deletedAt: typeof f.deleted_at === 'string' ? f.deleted_at : null,
  };
}

/** the list with that message turned into a tombstone (what the room and its thread do for a delete made here); the same list when there is nothing to change */
export function withMessageTombstoned<T extends { id: string; content?: string; deleted_at?: string | null }>(list: T[], messageId: string, deletedAt: string | null | undefined): T[] {
  let changed = false;
  const next = list.map((m) => {
    if (m.id !== messageId || m.deleted_at) return m;
    changed = true;
    return { ...m, content: '', deleted_at: deletedAt ?? new Date().toISOString() };
  });
  return changed ? next : list;
}

export function announceChatMessageDeleted(detail: ChatMessageDeletedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ChatMessageDeletedDetail>(CHAT_MESSAGE_DELETED_EVENT, { detail }));
}

/** subscribe; returns the unsubscribe */
export function onChatMessageDeleted(handler: (detail: ChatMessageDeletedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<ChatMessageDeletedDetail>).detail);
  window.addEventListener(CHAT_MESSAGE_DELETED_EVENT, listener);
  return () => window.removeEventListener(CHAT_MESSAGE_DELETED_EVENT, listener);
}

/**
 * An ISO time as whole MICROSECONDS since the epoch (what the server's database keeps) — or null when it is not an ISO time with an offset.
 * `Date.parse` keeps only milliseconds: two messages of one room created within the same millisecond would compare equal and the wrong one would be blanked (codex round 1).
 */
export function isoToMicros(iso: string | null | undefined): bigint | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(iso.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  if (!Number.isFinite(ms)) return null;
  const frac = (m[7] ?? '').padEnd(6, '0').slice(0, 6); // microseconds (a nanosecond tail is cut)
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const o = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8]!)!;
    offsetMin = (o[1] === '-' ? -1 : 1) * (+o[2]! * 60 + +(o[3] ?? 0));
  }
  return (BigInt(ms) - BigInt(offsetMin) * BigInt(60000)) * BigInt(1000) + BigInt(frac);
}

/** the same instant (to the microsecond), whatever the ISO spelling (`Z` vs `+00:00`, trailing zeros, fractional digits) */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = isoToMicros(a);
  const y = isoToMicros(b);
  return x !== null && y !== null && x === y;
}
