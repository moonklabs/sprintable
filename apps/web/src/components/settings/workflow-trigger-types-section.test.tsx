// @vitest-environment jsdom
//
// story #3608(유나 §22-18 ④-2, PO 確定 2026-09-07) — 저장·삭제확정·토글 pending 中
// "..."가 보이는 글자(토글은 그 접근 이름 안에도)에 그대로 떴다. 낱말("저장 중…"·
// "삭제 중…"·"변경 중…")로 바뀌었는지 검증하는 최초의 테스트 파일(이 컴포넌트는
// 이전엔 전용 테스트가 없었다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { WorkflowTriggerTypesSection } from './workflow-trigger-types-section';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const TRIGGER_TYPE = { id: 'tt-1', slug: 'custom_trigger', label: '커스텀 트리거', description: null, is_system: false, is_enabled: true };

function stubFetch(pendingMethod: 'PATCH' | 'DELETE', onResolve: (resolve: () => void) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/workflow-trigger-types' && (!init || init.method === undefined)) {
      return { ok: true, json: async () => [TRIGGER_TYPE] };
    }
    if (url === `/api/workflow-trigger-types/${TRIGGER_TYPE.id}` && init?.method === pendingMethod) {
      return new Promise((resolve) => { onResolve(() => resolve({ ok: true, json: async () => ({}) })); });
    }
    throw new Error('unexpected fetch: ' + url + ' ' + init?.method);
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<WorkflowTriggerTypesSection />)); });
  await flush();
}

describe('WorkflowTriggerTypesSection — pending 라벨 낱말화(story #3608)', () => {
  it('⭐#3608 — 저장 pending 中 보이는 글자에 "..." 0, "저장 중" 포함', async () => {
    let resolvePatch!: () => void;
    stubFetch('PATCH', (r) => { resolvePatch = r; });
    await mount();

    const editBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '수정');
    expect(editBtn).not.toBeUndefined();
    await act(async () => { editBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '저장' || b.textContent?.includes('저장 중'));
    expect(saveBtn).not.toBeUndefined();
    await act(async () => { saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(saveBtn!.textContent).not.toContain('...');
    expect(saveBtn!.textContent).toContain('저장 중');
    resolvePatch();
    await flush();
  });

  it('⭐#3608 — 삭제확정 pending 中 보이는 글자에 "..." 0, "삭제 중" 포함', async () => {
    let resolveDelete!: () => void;
    stubFetch('DELETE', (r) => { resolveDelete = r; });
    await mount();

    const deleteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '삭제');
    expect(deleteBtn).not.toBeUndefined();
    await act(async () => { deleteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '확인' || b.textContent?.includes('삭제 중'));
    expect(confirmBtn).not.toBeUndefined();
    await act(async () => { confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(confirmBtn!.textContent).not.toContain('...');
    expect(confirmBtn!.textContent).toContain('삭제 중');
    resolveDelete();
    await flush();
  });

  it('⭐#3608 — 토글 pending 中 접근 이름·보이는 글자에 "..." 0, "변경 중" 포함', async () => {
    let resolveToggle!: () => void;
    stubFetch('PATCH', (r) => { resolveToggle = r; });
    await mount();

    const toggleBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '비활성화' || b.textContent === '활성화');
    expect(toggleBtn).not.toBeUndefined();
    await act(async () => { toggleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(toggleBtn!.textContent).not.toContain('...');
    expect(toggleBtn!.textContent).toContain('변경 중');
    const ariaLabel = toggleBtn!.getAttribute('aria-label');
    expect(ariaLabel).not.toContain('...');
    expect(ariaLabel).toContain('변경 중');
    resolveToggle();
    await flush();
  });
});
