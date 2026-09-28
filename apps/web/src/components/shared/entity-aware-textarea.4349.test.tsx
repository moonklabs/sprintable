// @vitest-environment jsdom
//
// story #4349(전수 9번 · PO 11:39Z «부류를 닫는다») — `#` 엔티티 후보 목록이 스토리 상세 스크롤 면(`overflow-y-auto`) 안의 absolute라
// 면 아래 끝에서 잘린 채였다(AC5 트리 행 메뉴와 같은 모양). 이제 body로 포털(AnchoredPopover) · 입력칸 아래 4px · 모자라면 위로.
// 화살표 · Enter는 입력칸에 머무는 그대로(초점을 목록으로 옮기지 않는다). jsdom은 배치를 안 해서 입력칸 · 목록 사각형을 값으로 둔다(뷰포트 768).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EntityAwareTextarea } from './entity-aware-textarea';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ onValueChange }: { onValueChange: (v: string) => void }) {
  const [value, setValue] = useState('');
  return <EntityAwareTextarea value={value} onChange={(v) => { setValue(v); onValueChange(v); }} projectId="p1" />;
}

let container: HTMLDivElement;
let root: Root;
let taRect = { left: 16, right: 360, top: 200, bottom: 280 };

beforeEach(() => {
  taRect = { left: 16, right: 360, top: 200, bottom: 280 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isPop = this.hasAttribute('data-anchored-popover');
    const isTa = this.tagName === 'TEXTAREA';
    const r = isPop ? { left: 16, right: 304, top: 0, bottom: 120, width: 288, height: 120 }
      : isTa ? { ...taRect, width: taRect.right - taRect.left, height: taRect.bottom - taRect.top }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/entities/search')) {
      return new Response(JSON.stringify({ data: [
        { entity_type: 'story', entity_id: '11111111-1111-1111-1111-111111111111', title: '로그인 화면', status: null },
        { entity_type: 'story', entity_id: '22222222-2222-2222-2222-222222222222', title: '가입 흐름', status: null },
      ] }));
    }
    return new Response(JSON.stringify({ data: [] }));
  }));
  container = document.createElement('div');
  container.className = 'overflow-y-auto'; // 스토리 상세 스크롤 면 흉내
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function typeHash(onValueChange: (v: string) => void = () => {}) {
  await act(async () => { root.render(<Harness onValueChange={onValueChange} />); });
  const el = container.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  el.focus();
  await act(async () => { setter.call(el, '#'); el.selectionStart = 1; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
  return el;
}
const pop = () => document.querySelector<HTMLElement>('[data-anchored-popover]');

describe('EntityAwareTextarea `#` 후보 — 스크롤 면 밖(body)에 · 모자라면 위로(story #4349 전수 9번)', () => {
  it('후보 목록은 body 직속 fixed · 스크롤 면(overflow 조상) 밖 · 입력칸 아래 4px · 입력칸 왼쪽 · listbox 역할 그대로', async () => {
    await typeHash();
    expect(pop()!.parentElement).toBe(document.body);
    expect(container.contains(pop())).toBe(false);
    expect(pop()!.style.position).toBe('fixed');
    expect(pop()!.style.top).toBe('284px');
    expect(pop()!.style.left).toBe('16px');
    expect(pop()!.dataset.side).toBe('bottom');
    expect(pop()!.querySelector('[role="listbox"][data-dropdown-panel="entity-candidates"]')).not.toBeNull();
  });

  it('입력칸이 면 아래 끝이면(아래 남는 칸 < 120) 위로 뒤집는다', async () => {
    taRect = { left: 16, right: 360, top: 620, bottom: 700 };
    await typeHash();
    expect(pop()!.dataset.side).toBe('top');
    expect(pop()!.style.top).toBe('496px'); // 620 − 4 − 120
  });

  it('초점은 입력칸에 머물고 ↓ · Enter로 고른다(포털이어도 키보드 길 그대로)', async () => {
    let value = '';
    const el = await typeHash((v) => { value = v; });
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(el);
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(value).toContain('(entity:story:22222222-2222-2222-2222-222222222222)');
    expect(pop()).toBeNull();
  });
});

// story #4373(유나 4757 반려 · 실측 자리) — 1440 스토리 상세 패널(스스로 그린 role="dialog" · backdrop-blur-xl = fixed의 담는 블록) 안의
// `#` 후보가 2cb0d448c에서 패널 안으로 포털되며 x 693 → 1144로 밀렸다. 그 패널은 Base UI 모달이 아니라(밖을 숨기지 않음) 예전처럼 body.
describe('EntityAwareTextarea `#` 후보 — 스스로 그린 dialog 패널(스토리 상세) 안에서도 body · 입력칸 왼쪽 아래(story #4373)', () => {
  it('role="dialog" · backdrop-blur 패널 안이어도 후보는 body 직속 · 입력칸 왼쪽(16) · 아래 4px(284)', async () => {
    container.setAttribute('role', 'dialog');
    container.className = 'fixed inset-0 overflow-y-auto backdrop-blur-xl';
    await typeHash();
    expect(pop()!.parentElement).toBe(document.body);
    expect(pop()!.style.left).toBe('16px');
    expect(pop()!.style.top).toBe('284px');
  });
});

