// @vitest-environment jsdom
//
// story #4349(전수 11번 · PO 11:39Z «부류를 닫는다») — 목차 패널은 문서 본문 · 에디터 카드(`overflow-hidden`) 안의 absolute였다 → body로 포털.
// 포털이라 DOM 순서상 목차 버튼 뒤가 아니다 → 버튼에서 Tab이면 패널 첫 조작으로(예전 순서 그대로) · 첫 조작에서 Shift+Tab이면 버튼으로 ·
// 마지막에서 Tab이거나 Esc면 닫고 버튼으로(Esc는 셸 · 서랍 트랩까지 안 감). 아래 모자라면 위로.
// jsdom은 배치를 안 해서 버튼 wrapper · 패널 사각형을 값으로 둔다(뷰포트 768 · 패널 256×200).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocToc } from './doc-toc';
import type { DocHeading } from './doc-heading-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let wrapRect = { left: 200, right: 300, top: 60, bottom: 88 };

beforeEach(() => {
  wrapRect = { left: 200, right: 300, top: 60, bottom: 88 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isPanel = this.getAttribute('data-dropdown-panel') === 'doc-toc';
    const isWrap = !isPanel && this.classList.contains('relative') && this.querySelector(':scope > button') !== null;
    const r = isPanel ? { left: 44, right: 300, top: 0, bottom: 200, width: 256, height: 200 }
      : isWrap ? { ...wrapRect, width: wrapRect.right - wrapRect.left, height: wrapRect.bottom - wrapRect.top }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
  container = document.createElement('div');
  container.className = 'overflow-hidden'; // 문서 본문 · 에디터 카드 흉내
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

const HEADINGS: DocHeading[] = [
  { id: 'h1', text: '들어가며', level: 1 },
  { id: 'h2', text: '배경과 문제', level: 2 },
  { id: 'h3', text: '세부 결정', level: 3 },
];
function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocToc headings={HEADINGS} onHeadingClick={() => {}} />
      </NextIntlClientProvider>,
    );
  });
}
const btn = () => container.querySelector<HTMLButtonElement>('button')!;
const panel = () => document.querySelector<HTMLElement>('[data-dropdown-panel="doc-toc"]');
const key = (el: Element, k: string, shiftKey = false) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })); });

describe('DocToc — 카드 밖(body)에 · 모자라면 위로 · 키보드(story #4349 전수 11번)', () => {
  it('열면 body 직속 fixed · overflow 조상 밖 · 버튼 오른쪽 끝에 맞춰 아래 6px', () => {
    mount();
    act(() => { btn().click(); });
    expect(panel()!.parentElement).toBe(document.body);
    expect(container.contains(panel())).toBe(false);
    expect(panel()!.style.top).toBe('94px');
    expect(panel()!.style.left).toBe('44px'); // 300 − 256
  });

  it('버튼이 아래 끝이면(아래 남는 칸 < 200) 위로 뒤집는다', () => {
    wrapRect = { left: 200, right: 300, top: 640, bottom: 668 };
    mount();
    act(() => { btn().click(); });
    expect(panel()!.dataset.side).toBe('top');
    expect(panel()!.style.top).toBe('434px'); // 640 − 6 − 200
  });

  it('버튼에서 Tab → 패널 첫 조작 · Shift+Tab → 버튼(열린 채) · 마지막에서 Tab → 닫고 버튼 · Esc → 닫고 버튼(document 트랩 0)', () => {
    mount();
    btn().focus();
    act(() => { btn().click(); });
    expect(document.activeElement).toBe(btn()); // 패널형: 여는 순간 초점은 버튼에
    key(btn(), 'Tab');
    const items = () => Array.from(panel()!.querySelectorAll<HTMLButtonElement>('button'));
    expect(document.activeElement).toBe(items()[0]);
    key(items()[0], 'Tab', true);
    expect(document.activeElement).toBe(btn());
    expect(panel()).not.toBeNull();
    key(btn(), 'Tab');
    const last = items()[items().length - 1];
    last.focus();
    key(last, 'Tab');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(btn());
    const trap = vi.fn();
    document.addEventListener('keydown', trap);
    act(() => { btn().click(); });
    key(btn(), 'Tab');
    key(items()[1], 'Escape');
    document.removeEventListener('keydown', trap);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(btn());
    expect(trap.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0);
  });

  it('포털된 패널 안을 누르면 안 닫힘 · 바깥이면 닫힘', () => {
    mount();
    act(() => { btn().click(); });
    act(() => { panel()!.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(panel()).not.toBeNull();
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(panel()).toBeNull();
  });

  it('패널 ARIA(공용 훅) — 버튼 aria-expanded · aria-controls = 패널 id · 메뉴 역할 아님(haspopup · role=menu 없음)', () => {
    mount();
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(btn().hasAttribute('aria-controls')).toBe(false);
    act(() => { btn().click(); });
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(btn().getAttribute('aria-controls')).toBe(panel()!.id);
    expect(btn().hasAttribute('aria-haspopup')).toBe(false);
    expect(panel()!.hasAttribute('role')).toBe(false);
  });
});

// 유나 #4728 필수 2 — 새 키보드 길(«목차» → Tab)의 첫 자리 «✕»: 이름이 없었고, 누르면 초점이 body로 떨어졌다.
describe('DocToc «✕» — 이름 · 닫으면 «목차»로 초점(유나 #4728)', () => {
  it('«목차»에서 Tab → 첫 자리 = «✕»(이름 common.close) · 누르면 닫히고 초점 = «목차» 버튼(body 아님)', () => {
    mount();
    btn().focus();
    act(() => { btn().click(); });
    key(btn(), 'Tab');
    const x = document.activeElement as HTMLElement;
    expect(panel()!.contains(x)).toBe(true);
    expect(x.getAttribute('aria-label')).toBe(koMessages.common.close);
    act(() => { x.click(); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(btn());
    expect(document.activeElement).not.toBe(document.body);
  });
});

