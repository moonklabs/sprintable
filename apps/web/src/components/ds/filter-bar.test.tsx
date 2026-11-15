// 4913(UI-R5) FilterBar — 거르기 줄 한 가지 꼴: 왼쪽 탭/칩 · 오른쪽 토글, 폰에서 «필터 · n개» 한 단추로 접힘.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FilterBar } from './filter-bar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const body = () => container.querySelector('[data-slot="ds-filter-bar-body"]') as HTMLElement;
const toggle = () => container.querySelector('button[aria-controls]') as HTMLButtonElement | null;

describe('ds FilterBar', () => {
  it('⭐접힘 단추를 안 주면 늘 펼쳐 있고 단추가 없다 · 왼쪽 leading / 오른쪽 trailing', async () => {
    await act(async () => { root.render(<FilterBar aria-label="목록 거르기" leading={<span>탭</span>} trailing={<span>토글</span>} />); });
    expect(toggle()).toBeNull();
    expect(body().className).toContain('flex');
    expect(body().className).not.toContain('hidden');
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('목록 거르기');
    expect(body().firstElementChild?.textContent).toBe('탭');
    expect(body().lastElementChild?.textContent).toBe('토글');
  });

  it('⭐접힘: 폰에서는 기본 닫힘(hidden sm:flex) · 단추를 누르면 열리고 aria-expanded/aria-controls가 맞는다', async () => {
    await act(async () => { root.render(<FilterBar collapseLabel="필터" leading={<span>탭</span>} />); });
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
    expect(body().className).toContain('hidden');
    expect(body().className).toContain('sm:flex');
    expect(toggle()!.getAttribute('aria-controls')).toBe(body().id);
    expect(toggle()!.className).toContain('sm:hidden');
    await act(async () => { toggle()!.click(); });
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(body().className).not.toContain('hidden');
    await act(async () => { toggle()!.click(); });
    expect(body().className).toContain('hidden');
  });

  it('⭐적용 중인 거르기 수가 단추에 붙는다(0이면 안 붙는다)', async () => {
    await act(async () => { root.render(<FilterBar collapseLabel="필터" activeCount={2} leading={<span>탭</span>} />); });
    expect(toggle()!.textContent).toBe('필터 · 2');
    await act(async () => { root.render(<FilterBar collapseLabel="필터" activeCount={0} leading={<span>탭</span>} />); });
    expect(toggle()!.textContent).toBe('필터');
  });
});
