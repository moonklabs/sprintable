// @vitest-environment jsdom
// story #4376 — 부모가 이 목록에 없는 문서(부모가 지워짐 · 태그 필터로 부모가 빠짐)도 뿌리에 보인다. 예전엔 뿌리를 `!parent_id`로만
// 골라 그런 문서가 트리 어디에도 안 그려졌다(dev: 부모가 목록에 없는 자식 1개). 부모가 목록에 있으면 예전처럼 그 밑(뿌리 아님).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocTree } from './doc-tree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const doc = (id: string, parent_id: string | null, title: string, is_folder = false) => ({
  id, parent_id, title, slug: id, icon: null, sort_order: 0, is_folder,
});

function render(docs: ReturnType<typeof doc>[]) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocTree docs={docs} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} projectId="p-4376" />
      </NextIntlClientProvider>,
    );
  });
}

describe('DocTree 뿌리 — 부모가 목록에 없는 문서도 보인다(story #4376)', () => {
  // 깊이 = 행 왼쪽 여백(depth * 14 + 8px) — 뿌리 8px · 한 층 아래 22px.
  const indent = (id: string) => (container.querySelector<HTMLElement>(`[data-doc-id="${id}"]`)?.style.paddingLeft ?? null);

  it('부모가 목록에 없는 문서는 뿌리에(깊이 0) · 부모가 있는 문서는 그 밑(깊이 1)', () => {
    render([
      doc('folder', null, '폴더', true),
      doc('child', 'folder', '폴더 속 문서'),
      doc('orphan', 'gone-parent', '부모 지워진 문서'),
    ]);
    expect(indent('orphan')).toBe('8px');  // 예전(뿌리 = !parent_id)엔 아예 안 그려져 null
    expect(indent('folder')).toBe('8px');
    expect(indent('child')).toBe('22px');
  });
});
