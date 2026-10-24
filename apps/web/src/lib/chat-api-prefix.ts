/**
 * story #4762 (AC1) — the one address a chat message is read from and sent to: `{prefix}/{conversationId}/messages`.
 *
 * The chat screen passes this to `ChatView` (`apiPrefix`), and the Today instruction line sends through it too. They were two spellings of the same
 * address: the screen wrote `/api/conversations`, the instruction line wrote `ChatView`'s old default `/api/chats` — a web route that proxies to a
 * backend address that does not exist (`/api/v2/chats/…`), so the instruction line's POST answered 404 on dev (measured on a phone, 10-24). One value
 * now; `chat-api-prefix.test.ts` ties it to the route that really reaches the backend's conversations.
 */
export const CHAT_API_PREFIX = '/api/conversations';
