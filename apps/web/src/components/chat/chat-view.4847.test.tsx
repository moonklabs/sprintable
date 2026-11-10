// @vitest-environment jsdom
//
// story 4847 — a room with no project (it outlives its project since 4846 PR1) cannot take a NEW attachment. The refusal is a coded envelope — `{ data: null, error: { code:
// 'ATTACHMENT_NEEDS_PROJECT', message }, meta: null }`, 400 — from the web's own upload route (it puts the file in storage itself) and from the server's send that registers the
// attachment. The screen reads the CODE and says why in its own words, instead of the bare «첨부 업로드 실패» / «전송 실패». Harness as chat-view.4444.test.tsx.
// (4846 PR2 · AC6 lifts the refusal: these tests describe the refusal; when the code stops coming the screen simply never takes this branch.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/chats/thread-1',
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: () => ({ connected: true, polling: false }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const NEEDS = { data: null, error: { code: 'ATTACHMENT_NEEDS_PROJECT', message: '프로젝트 없는 방에는 새 첨부를 올릴 수 없어요' }, meta: null };
const needs = koMessages.chats.attachmentNeedsProject;

type Plan = { upload: { status: number; body: unknown }; send?: { status: number; body: unknown } };

async function mountAndSend(plan: Plan) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (typeof url === 'string' && url.includes('/messages?')) return { ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) };
    if (url === '/api/conversations/thread-1/attachments' && init?.method === 'POST') {
      return { ok: plan.upload.status < 400, status: plan.upload.status, json: async () => { if (plan.upload.body === undefined) throw new SyntaxError('not json'); return plan.upload.body; } };
    }
    if (url === '/api/conversations/thread-1/messages' && init?.method === 'POST') {
      const s = plan.send ?? { status: 201, body: { data: {} } };
      return { ok: s.status < 400, status: s.status, json: async () => s.body };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" projectId={undefined} /></ChatRailProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.txt', { type: 'text/plain' })] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  return { fetchMock, alerts: [...container.querySelectorAll('[role=alert]')].map((e) => e.textContent).join(' | ') };
}

describe('ChatView — a room with no project: the attachment is refused by code and the screen says why (story 4847)', () => {
  it('⭐the upload route\'s 400 ATTACHMENT_NEEDS_PROJECT → the one-line reason (not the bare failure)', async () => {
    const { alerts, fetchMock } = await mountAndSend({ upload: { status: 400, body: NEEDS } });
    expect(alerts).toContain(needs);
    expect(alerts).not.toContain(koMessages.chats.attachmentUploadFailed);
    expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/conversations/thread-1/messages' && (i as { method?: string })?.method === 'POST')).toBe(false); // nothing was sent
  });

  it('⭐the send\'s 400 ATTACHMENT_NEEDS_PROJECT (an already stored asset attached) → the same reason, not «전송 실패»', async () => {
    const { alerts } = await mountAndSend({ upload: { status: 200, body: { url: 'u', name: 'a.txt', content_type: 'text/plain', size: 1 } }, send: { status: 400, body: NEEDS } });
    expect(alerts).toContain(needs);
    expect(alerts).not.toContain(koMessages.chats.sendFailed);
  });

  it('any other upload refusal keeps the bare failure line (the web speaks for one code only)', async () => {
    const { alerts } = await mountAndSend({ upload: { status: 502, body: { error: { message: 'upload failed' } } } });
    expect(alerts).toContain(koMessages.chats.attachmentUploadFailed);
    expect(alerts).not.toContain(needs);
  });

  it('a different coded 400 is not read as this one', async () => {
    const { alerts } = await mountAndSend({ upload: { status: 400, body: { data: null, error: { code: 'SOMETHING_ELSE', message: 'x' }, meta: null } } });
    expect(alerts).toContain(koMessages.chats.attachmentUploadFailed);
    expect(alerts).not.toContain(needs);
  });

  it('a refusal body that is not JSON still ends as the bare failure (no crash)', async () => {
    const { alerts } = await mountAndSend({ upload: { status: 500, body: undefined } });
    expect(alerts).toContain(koMessages.chats.attachmentUploadFailed);
  });
});
