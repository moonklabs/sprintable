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

async function render(props: { messageId: string; content: string; isMine: boolean }) {
  await act(async () => {
    root.render(withIntl(<ReferenceSuggestionRow {...props} />));
  });
}

describe('ReferenceSuggestionRow — story #2283', () => {
  it('남의 메시지(isMine=false)엔 후보가 있어도 아무것도 안 뜬다(작성자 본인에게만)', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: false });
    expect(container.textContent).toBe('');
  });

  it('후보가 없으면 아무것도 안 뜬다', async () => {
    await render({ messageId: 'm1', content: '그냥 평범한 메시지입니다', isMine: true });
    expect(container.textContent).toBe('');
  });

  it('본인 메시지에 평문 #번호가 있으면 제안이 뜬다', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true });
    expect(container.textContent).toContain('#2249를 스토리로 잇겠습니까?');
    expect(container.textContent).toContain('예');
  });

  it('⛔누르기 전에는 「예」를 눌러도 조용히 성공한 척하지 않고 "곧 지원" 문구를 보여준다(자동확정 금지)', async () => {
    await render({ messageId: 'm1', content: '#2249 확認 부탁', isMine: true });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '예');
    await act(async () => { confirmBtn!.click(); });
    expect(container.textContent).toContain('곧 지원됩니다');
    expect(container.textContent).not.toContain('연결되었습니다');
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
