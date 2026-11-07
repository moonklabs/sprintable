// @vitest-environment jsdom
//
// story 4854 — links in a chat bubble. A bare address in a plain message used to be a <span> (not
// clickable), an @ in an e-mail address turned the mail link into a mention, and a javascript: link
// became an anchor with an empty href that re-opened the current page. Rendered with a real DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] }),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src?: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(content: string) {
  const message: ChatMessage = {
    id: 'msg-1', memo_id: 'conv-1', created_by: 'agent-1', sender_name: 'probe', sender_type: 'agent',
    sender_avatar_url: null, sender_runtime_type: null, content, attachments: [], created_at: '2026-11-08T00:00:00.000Z',
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatBubble message={message} isMine={false} />
      </NextIntlClientProvider>,
    );
  });
}
const anchors = () => Array.from(container.querySelectorAll('a'));
const hrefs = () => anchors().map((a) => a.getAttribute('href'));

describe('[SID:4854] plain message with a bare address', () => {
  it('becomes an anchor that opens in a new window without opener', async () => {
    await render('BARE-URL https://example.net/bare-url end');
    expect(hrefs()).toEqual(['https://example.net/bare-url']);
    const a = anchors()[0];
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('https://example.net/bare-url');
    expect(container.textContent).toContain('BARE-URL ');
    expect(container.textContent).toContain(' end');
  });
  it('keeps a closing period, a closing bracket and a Korean particle out of the address', async () => {
    await render('see https://example.net/a. (https://example.net/b) https://example.net/c를 확인');
    expect(hrefs()).toEqual(['https://example.net/a', 'https://example.net/b', 'https://example.net/c']);
  });
  it('does not link a javascript: text, a bare host or a mail address in plain text', async () => {
    await render('javascript:alert(1) www.example.org/z probe@example.org');
    expect(anchors()).toHaveLength(0);
  });
});

describe('[SID:4854] markdown links', () => {
  it('an outside link keeps target=_blank rel=noopener noreferrer', async () => {
    await render('**go** [md-link](https://example.org/md-link)');
    const a = anchors().find((x) => x.getAttribute('href') === 'https://example.org/md-link')!;
    expect(a).toBeDefined();
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('a bare address inside markdown text is still one anchor', async () => {
    await render('**bold** https://example.net/gfm');
    expect(hrefs()).toEqual(['https://example.net/gfm']);
  });
  it('a javascript: link is text, not an anchor that re-opens this page', async () => {
    await render('[click me](javascript:alert(1)) and **x**');
    expect(anchors()).toHaveLength(0);
    expect(container.textContent).toContain('click me');
  });
  it('a mailto: link stays a mail link and the address is not turned into a mention', async () => {
    await render('**mail** [write](mailto:probe@example.org) or probe@example.org');
    const mail = anchors().find((x) => x.getAttribute('href') === 'mailto:probe@example.org')!;
    expect(mail).toBeDefined();
    expect(mail.getAttribute('target')).toBeNull();
    expect(hrefs().every((h) => h === 'mailto:probe@example.org')).toBe(true);
  });
  it('an @name that starts a word is still a mention, and the «@example» of an e-mail address beside it is not', async () => {
    await render('**hi** @alice, mail probe@example.org');
    const mentions = Array.from(container.querySelectorAll('span.font-medium.text-primary'));
    expect(mentions.map((m) => m.textContent)).toEqual(['@alice']);
    expect(container.textContent).toContain('probe@example.org');
  });
});
