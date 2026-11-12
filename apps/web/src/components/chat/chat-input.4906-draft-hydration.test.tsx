// @vitest-environment jsdom
//
// story 4906 (QA lens ⑤, dev 11-12) — leave a half-written message, reload: the box shows the draft but [보내기] stays OFF until one character is changed.
// Measured on dev (React's own props read off the DOM after the reload): the button's React prop says `disabled=false` while the DOM button is still `disabled` — a hydration mismatch.
// The server draws the room without a draft (no localStorage there: `text=''`, the button disabled); the client's FIRST render read the draft in the `useState` initializer (`text='쓰던 내용'`,
// the button enabled) — and React does not patch an attribute that differs from the server's HTML. The draft is restored AFTER mount now: the first client render equals the server's,
// then the restore is an ordinary state update and the DOM follows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

const tree = (threadId = 'c1') => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
    <ChatInput threadId={threadId} onSend={vi.fn()} />
  </NextIntlClientProvider>
);

let store: Map<string, string>;
let container: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => { store.clear(); } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const textarea = () => container.querySelector('textarea[data-slot="textarea"]') as HTMLTextAreaElement;
const sendButton = () => container.querySelector(`button[aria-label="${koMessages.chats.sendAction}"]`) as HTMLButtonElement;

/** the server's HTML (no browser storage there), then the browser with a stored draft hydrating it */
async function reloadWithDraft(draft: string | null) {
  container.innerHTML = renderToString(tree()); // before the draft exists: what the server sends
  if (draft !== null) {
    store.set('sprintable_tab_owner', 'user-a');
    store.set('sprintable:chat-draft:u:user-a:c1', draft);
  }
  const errors: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(container, tree(), { onRecoverableError: (e) => { errors.push(e); } });
  });
  return errors;
}

describe('ChatInput — a restored draft after a reload (hydration)', () => {
  it('⭐ the box shows the draft AND [보내기] is on — in the DOM, not only in React\'s props', async () => {
    const errors = await reloadWithDraft('쓰던 내용');
    expect(textarea().value).toBe('쓰던 내용');
    expect(sendButton().disabled).toBe(false); // reverted (the draft is read in the useState initializer) → true: the DOM keeps the server's `disabled`
    expect(errors, 'no hydration error either').toEqual([]);
  });

  it('with no stored draft nothing changes: the box is empty and [보내기] is off', async () => {
    await reloadWithDraft(null);
    expect(textarea().value).toBe('');
    expect(sendButton().disabled).toBe(true);
  });

  it('the stored draft is still there after the restore (a second reload finds it again)', async () => {
    await reloadWithDraft('쓰던 내용');
    expect(store.get('sprintable:chat-draft:u:user-a:c1')).toBe('쓰던 내용');
  });

  it('typing after the restore replaces the draft: the box, [보내기] and the stored slot follow the new text', async () => {
    await reloadWithDraft('쓰던 내용');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea(), '새로 쓴 글');
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea().value).toBe('새로 쓴 글');
    expect(sendButton().disabled).toBe(false);
    expect(store.get('sprintable:chat-draft:u:user-a:c1')).toBe('새로 쓴 글');
  });
});
