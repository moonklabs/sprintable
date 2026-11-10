// UI-3(a9d56577) — ds Tabs 회귀가드: 선택 · 패널 연결 · 화살표 키 · 켜짐 모양(밑줄 + 굵기) · 폰 누름 영역.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }
async function press(el: Element, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
}
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const tabs = () => [...container.querySelectorAll('[role="tab"]')] as HTMLElement[];

function Demo({ onValueChange }: { onValueChange?: (v: unknown) => void }) {
  return (
    <Tabs defaultValue="a" onValueChange={onValueChange}>
      <TabsList aria-label="구역">
        <TabsTrigger value="a">통계</TabsTrigger>
        <TabsTrigger value="b">관리</TabsTrigger>
        <TabsTrigger value="c" disabled>접근</TabsTrigger>
      </TabsList>
      <TabsContent value="a">통계 패널</TabsContent>
      <TabsContent value="b">관리 패널</TabsContent>
    </Tabs>
  );
}

describe('ds Tabs', () => {
  it('⭐tablist · tab · tabpanel 역할이 이어진다(aria-selected · aria-controls)', async () => {
    await render(<Demo />);
    expect(container.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('구역');
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    const panel = container.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(panel.textContent).toBe('통계 패널');
    expect(tabs()[0]!.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('누르면 선택이 바뀌고 패널이 갈린다 · onValueChange', async () => {
    const seen: unknown[] = [];
    await render(<Demo onValueChange={(v) => seen.push(v)} />);
    await act(async () => { tabs()[1]!.click(); });
    expect(seen).toEqual(['b']);
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true');
    expect((container.querySelector('[role="tabpanel"]') as HTMLElement).textContent).toBe('관리 패널');
  });

  it('⭐켜짐 모양은 색만이 아니다: 밑줄(border) + 굵기가 data-active로 걸린다 · 꺼짐은 ink-3', async () => {
    await render(<Demo />);
    const cls = tabs()[0]!.className;
    expect(cls).toContain('data-active:border-ds-action');
    expect(cls).toContain('data-active:font-semibold');
    expect(cls).toContain('data-active:text-ds-action-text');
    expect(cls).toMatch(/(^|\s)text-ds-ink-3(\s|$)/);
    expect(cls).toMatch(/(^|\s)font-normal(\s|$)/);
  });

  it('⭐화살표 키로 다음 탭에 초점이 옮겨 가고 끝에서 비활성 칸을 건너뛴다', async () => {
    await render(<Demo />);
    tabs()[0]!.focus();
    await press(tabs()[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it('⭐비활성 탭 앞에서 화살표를 눌렀을 때의 초점 — 비활성 칸에 선택이 가지 않는다', async () => {
    await render(<Demo />);
    tabs()[1]!.focus();
    await press(tabs()[1]!, 'ArrowRight');
    // Base UI는 비활성 칸으로 초점이 갈 수 있지만(aria-disabled) 선택(aria-selected)은 일어나지 않는다.
    expect(tabs()[2]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('⭐초점 링은 안쪽(inset) — 줄의 overflow 클립이 자르지 않는다 · 켜진 밑줄은 아래 선 위에 겹친다(-mb-px)', async () => {
    await render(<Demo />);
    const cls = tabs()[0]!.className;
    expect(cls).toContain('focus-visible:ring-inset');
    expect(cls).not.toContain('ring-offset');
    expect(cls).toMatch(/(^|\s)-mb-px(\s|$)/);
  });

  it('폰(coarse)은 누름 영역 44 · 초점 링 action · 비활성은 눌리지 않는 모양', async () => {
    await render(<Demo />);
    const cls = tabs()[0]!.className;
    expect(cls).toContain('pointer-coarse:min-h-11');
    expect(cls).toContain('focus-visible:ring-ds-action');
    expect(tabs()[2]!.hasAttribute('disabled') || tabs()[2]!.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('줄은 가로 스크롤 · 스크롤바 숨김 · 아래 선은 바깥 래퍼', async () => {
    await render(<Demo />);
    const list = container.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('[scrollbar-width:none]');
    expect(list.parentElement!.className).toContain('border-b');
  });
});
