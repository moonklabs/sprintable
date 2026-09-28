// @vitest-environment jsdom
//
// story #4359(유나 4740 판) — 문서 트리 «이름 변경» 창: 열 때 지금 이름 **전부 선택**(바꾼 브라우저 prompt처럼 치면 바뀜) ·
// 닫힌 뒤(취소 · 저장 둘 다) 초점은 연 행의 «⋮»로(연 메뉴 항목은 이미 사라져 body로 떨어졌다). 실 DocTree 배선으로 잰다.
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DOC = { id: 'd1', parent_id: null, title: '회의록', slug: 'd1', icon: null, sort_order: 0 };

async function mount(onRename = vi.fn(async () => {})) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocTree docs={[DOC]} selectedSlug={null} onSelect={() => {}} onRename={onRename} projectId="p1" />
      </NextIntlClientProvider>,
    );
  });
  return onRename;
}
// «⋮» = 행의 마지막 role=button div(첫째는 dnd-kit 끌기 손잡이).
const trigger = () => Array.from(container.querySelector<HTMLElement>('[data-doc-id="d1"]')!.parentElement!.querySelectorAll<HTMLElement>(':scope > div[role="button"]')).at(-1)!;
const input = () => document.querySelector<HTMLInputElement>('[data-testid="doc-rename-input"]');
const dialog = () => document.querySelector<HTMLElement>('[data-testid="doc-rename-dialog"]');

async function openRename() {
  await act(async () => { trigger().focus(); trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  const renameItem = document.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"] button')!;
  expect(renameItem.textContent).toBe(koMessages.docs.docTreeRename);
  await act(async () => { renameItem.click(); });
  await settle();
}
// base-ui 창은 닫힘 뒤 초점을 다음 틱들에 돌려준다 — 틱을 몇 번 흘린다.
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('DocTree «이름 변경» 창 — 전부 선택 · 닫힌 뒤 «⋮»로 초점(story #4359 · 유나)', () => {
  it('⭐열면 지금 이름이 **전부 선택**된 채 초점 — 치면 바뀐다(덧붙지 않음)', async () => {
    await mount();
    await openRename();
    const el = input()!;
    expect(document.activeElement).toBe(el);
    expect(el.value).toBe('회의록');
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, '회의록'.length]);
  });

  it('⭐취소로 닫으면 초점이 그 행의 «⋮»로', async () => {
    await mount();
    await openRename();
    const cancel = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === koMessages.docs.cancel)!;
    await act(async () => { cancel.click(); });
    await settle();
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('⭐저장(Enter)으로 닫아도 초점이 그 행의 «⋮»로 · 이름 바꾸기 호출', async () => {
    const onRename = await mount();
    await openRename();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input()!, '새 회의록');
      input()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await settle();
    expect(onRename).toHaveBeenCalledWith('d1', '새 회의록');
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
