// @vitest-environment jsdom
// story 5048 T0 ②b — BigTabs: 큰 제목 탭(24 Semibold · 고른 것 = 본문 색 · 나머지 = 셋째 글자색). 실 DOM(createRoot) · Base UI 탭.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Tabs, TabsContent } from './tabs';
import { BigTabsList, BigTabsTrigger } from './big-tabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
async function render(node: ReactNode) { await act(async () => { root.render(node); }); }

const Demo = () => (
  <Tabs defaultValue="a">
    <BigTabsList aria-label="큰 탭">
      <BigTabsTrigger value="a">대화</BigTabsTrigger>
      <BigTabsTrigger value="b">문서</BigTabsTrigger>
    </BigTabsList>
    <TabsContent value="a">대화 패널</TabsContent>
    <TabsContent value="b">문서 패널</TabsContent>
  </Tabs>
);

describe('ds BigTabs (story 5048 T0 ②b)', () => {
  it('탭 역할 · 선택이 aria-selected로 · 누르면 패널이 갈린다', async () => {
    await render(<Demo />);
    const tabs = [...container.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    await act(async () => { tabs[1]!.click(); });
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect((container.querySelector('[role="tabpanel"]') as HTMLElement).textContent).toBe('문서 패널');
  });

  it('⭐키트 결: 24 Semibold 제목 글자(text-ds-title) · 높이 40 · 꺼짐 ink-3 · 켜짐 ink — 면 · 밑줄 없음', async () => {
    await render(<Demo />);
    const cls = (container.querySelector('[role="tab"]') as HTMLElement).className;
    expect(cls).toMatch(/(^|\s)text-ds-title(\s|$)/);
    expect(cls).toContain('min-h-ds-control');
    expect(cls).toMatch(/(^|\s)text-ds-ink-3(\s|$)/);
    expect(cls).toContain('data-active:text-ds-ink');
    expect(cls).not.toMatch(/bg-ds-|border-b/);
    expect(cls).toContain('touch:min-h-ds-touch');
  });
});
