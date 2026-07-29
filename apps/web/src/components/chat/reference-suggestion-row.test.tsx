// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ReferenceSuggestionRow } from './reference-suggestion-row';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: Map<string, string>;
function stubLocalStorage() {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubLocalStorage();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: { messageId: string; content: string; isMine: boolean; projectId?: string }) {
  await act(async () => {
    root.render(withIntl(<ReferenceSuggestionRow {...props} />));
  });
}

describe('ReferenceSuggestionRow — story #2283', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('남의 메시지(isMine=false)엔 후보가 있어도 아무것도 안 뜬다(작성자 본인에게만)', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: false });
    expect(container.textContent).toBe('');
  });

  it('후보가 없으면 아무것도 안 뜬다', async () => {
    await render({ messageId: 'm1', content: '그냥 평범한 메시지입니다', isMine: true });
    expect(container.textContent).toBe('');
  });

  it('본인 메시지에 평문 #번호가 있으면 「스토리로」 제안이 뜬다', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true, projectId: 'p1' });
    expect(container.textContent).toContain('#2249를 스토리로 잇겠습니까?');
    expect(container.textContent).toContain('예');
  });

  it('평문 #슬러그는 「문서로」 제안이 뜬다(스토리 아님)', async () => {
    await render({ messageId: 'm1', content: '#flow-map-v1 참조', isMine: true, projectId: 'p1' });
    expect(container.textContent).toContain('#flow-map-v1를 문서로 잇겠습니까?');
  });

  it('projectId가 없으면 「예」를 눌러도 실패로 처리된다(해소 스코프 없이 조회 안 함)', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '예');
    await act(async () => { confirmBtn!.click(); });
    expect(container.textContent).toContain('연결이 저장되지 않았습니다');
    expect(container.textContent).toContain('다시 시도');
  });

  it('해소(story_number lookup) + POST 성공 시 — 성공 문구 없이 조용히 되돌리기 버튼으로 전환된다', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/stories?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'story-uuid-1' }] }) });
      }
      if (url === '/api/references') {
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 'ref-uuid-1' }) });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true, projectId: 'p1' });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '예');
    await act(async () => { confirmBtn!.click(); });
    // 해소(GET)→POST 두 단계 비동기라 microtask 플러시를 한 번 더 기다린다.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain('연결되었습니다');
    expect(container.textContent).not.toContain('저장');
    expect(container.textContent).toContain('연결 취소');
  });

  it('해소 실패(대상 없음) 시 — 종류-무관 실패 문구(POST를 아예 안 부른다)', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/stories?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true, projectId: 'p1' });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '예');
    await act(async () => { confirmBtn!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('연결이 저장되지 않았습니다');
    expect(fetchMock).not.toHaveBeenCalledWith('/api/references', expect.anything());
  });

  it('POST 실패(권한/네트워크) 시에도 같은 종류-무관 실패 문구', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/stories?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'story-uuid-1' }] }) });
      }
      if (url === '/api/references') {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: { message: 'not found' } }) });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true, projectId: 'p1' });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '예');
    await act(async () => { confirmBtn!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('연결이 저장되지 않았습니다');
  });

  it('연결 취소(undo)를 누르면 DELETE 호출 후 원래 확인 프롬프트로 되돌아간다', async () => {
    const fetchMock = vi.fn((url: string, init?: { method?: string }) => {
      if (url.includes('/api/stories?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'story-uuid-1' }] }) });
      }
      if (url === '/api/references') {
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 'ref-uuid-1' }) });
      }
      if (url === '/api/references/ref-uuid-1' && init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true, projectId: 'p1' });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '예');
    await act(async () => { confirmBtn!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const undoBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '연결 취소');
    await act(async () => { undoBtn!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('#2249를 스토리로 잇겠습니까?');
  });

  it('「묻지 않기」를 누르면 그 후보가 즉시 사라진다(같은 렌더 인스턴스 내 즉시 반영)', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true });
    const rejectBtn = container.querySelector('button[aria-label="묻지 않기"]') as HTMLButtonElement;
    await act(async () => { rejectBtn.click(); });
    expect(container.textContent).toBe('');
  });

  it('거절 후 재마운트해도(localStorage 기억) 같은 메시지의 같은 후보는 다시 안 뜬다', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true });
    const rejectBtn = container.querySelector('button[aria-label="묻지 않기"]') as HTMLButtonElement;
    await act(async () => { rejectBtn.click(); });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true });
    expect(container.textContent).toBe('');
  });
});
