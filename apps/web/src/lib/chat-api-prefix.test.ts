// story #4762 (AC1) — the address a chat message goes to is ONE value, and it is the one that really reaches the backend's conversations.
// Measured 10-24 on a phone: the Today instruction line posted to `/api/chats/{id}/messages` (a 404 on dev) while the chat screen posted to
// `/api/conversations/{id}/messages`. The unit tests of the line used a fake fetch and expected the same wrong address, so they passed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_API_PREFIX } from './chat-api-prefix';

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe('CHAT_API_PREFIX', () => {
  it('is a web route whose POST proxies to the backend\'s conversations messages (not `/api/v2/chats`, which the backend does not serve)', () => {
    expect(CHAT_API_PREFIX.startsWith('/api/')).toBe(true);
    const route = read(`app${CHAT_API_PREFIX}/[conversation_id]/messages/route.ts`);
    const at = route.indexOf('export async function POST');
    expect(at).toBeGreaterThan(-1);
    // the POST handler itself (not the GET above it) — a send that regressed to another backend address must not hide behind a correct read
    expect(route.slice(at)).toMatch(/proxyToFastapi\(request, `\/api\/v2\/conversations\/\$\{conversation_id\}\/messages`\)/);
  });

  it('is ChatView\'s own default too (a ChatView mounted without `apiPrefix` must not fall back to a dead address)', () => {
    const view = read('components/chat/chat-view.tsx');
    expect(view).toMatch(/apiPrefix = CHAT_API_PREFIX,/);
    expect(view).not.toMatch(/apiPrefix = '/);
  });

  it('is what the chat screen hands ChatView as `apiPrefix` (no spelling of its own there)', () => {
    const page = read('app/(authenticated)/chats/[conversation_id]/page.tsx');
    expect(page).toMatch(/apiPrefix=\{CHAT_API_PREFIX\}/);
    expect(page).not.toMatch(/apiPrefix="/);
  });

  it('is what the Today instruction line sends through (no `/api/…` literal in its send)', () => {
    const line = read('lib/today-instruct.ts');
    expect(line).toMatch(/fetchWithAuth\(`\$\{CHAT_API_PREFIX\}\/\$\{encodeURIComponent\(conversationId\)\}\/messages`/);
    expect(line).not.toMatch(/`\/api\/chats/);
  });
});
