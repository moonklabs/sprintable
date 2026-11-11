/**
 * story 4887 (UI-4) — «a message was deleted» as a window event between the places that hold copies of the conversation's latest message.
 * The room (ChatView) and its thread panel delete a message; the room LIST (ChatListView, another component tree) keeps the latest message of each room as a one-line preview — and kept showing a deleted message's text
 * until its next refetch. The server scrubs it on refetch (content «» · no attachment flag); this event lets the list do the same at once. The list's latest-message record has no id, so the event carries the message's `created_at`.
 * Only THIS person's own screens hear it: the server publishes no live delete signal to other participants (its own comment: «AC7 blind spot — out of scope»).
 */
export const CHAT_MESSAGE_DELETED_EVENT = 'sprintable:chat-message-deleted';

export interface ChatMessageDeletedDetail {
  conversationId: string;
  /** the deleted message's `created_at`, as the server sent it */
  createdAt: string;
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

/** the same instant, whatever the ISO spelling (`Z` vs `+00:00`, fractional digits) */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}
