// @vitest-environment jsdom
//
// story #4120(PO 실측, 2026-09-21) — docTreeDeleteBody의 「{title}을(를)」 고정 조사가
// doc.title 받침 유무와 안 맞으면 비문이 된다(pickEulReulJosa 렌더 시점 결정 처방,
// #4117 gcRevokeConfirmTitle 선례와 동형).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocTree } from './doc-tree';

interface Doc {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  updated_at?: string;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// story #2059 관례(kanban-board.test.tsx) — jsdom ambient localStorage 미제공 폴리필.
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

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

function makeDoc(id: string, title: string): Doc {
  return { id, parent_id: null, title, slug: id, icon: null, sort_order: 0 };
}

async function openDeleteConfirm(title: string) {
  const doc = makeDoc('d1', title);
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocTree docs={[doc]} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} projectId="p1" />
      </NextIntlClientProvider>,
    );
  });
  const row = document.body.querySelector<HTMLButtonElement>(`[data-doc-id="${doc.id}"]`)!;
  act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
  const deleteMenuItem = [...document.body.querySelectorAll('button')]
    .find((b) => b.textContent === koMessages.docs.docTreeDelete)!;
  act(() => { deleteMenuItem.click(); });
}

describe('DocTree — docTreeDeleteBody 조사(story #4120)', () => {
  it('받침 없는 제목 → «를»', async () => {
    await openDeleteConfirm('디자인 문서');
    expect(document.body.textContent).toContain('디자인 문서를 삭제하면 되돌릴 수 없어요.');
    expect(document.body.textContent).not.toContain('을(를)');
  });

  it('받침 있는 제목 → «을»', async () => {
    await openDeleteConfirm('회의록');
    expect(document.body.textContent).toContain('회의록을 삭제하면 되돌릴 수 없어요.');
    expect(document.body.textContent).not.toContain('을(를)');
  });
});
