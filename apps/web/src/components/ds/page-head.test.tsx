// 4913(UI-R5) PageHead — 제목 없는 쪽 머리: 설명 · 보조 글 · 행동. 제목은 위 막대(TopBarSlot)가 가져간다(PO 11-12).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PageHead } from './page-head';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('ds PageHead', () => {
  it('⭐제목(heading)을 절대 그리지 않는다 — 설명 + 행동만', async () => {
    await act(async () => { root.render(<PageHead description="이 화면이 하는 일" meta="마지막 수정 · 어제" actions={<button type="button">주 행동</button>} />); });
    expect(container.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')).toBeNull();
    expect(container.textContent).toContain('이 화면이 하는 일');
    expect(container.textContent).toContain('마지막 수정 · 어제');
    expect(container.querySelector('[data-slot="ds-page-head-actions"] button')?.textContent).toBe('주 행동');
  });

  it('⭐설명 · 보조 글 · 행동이 다 없으면 아무것도 그리지 않는다(빈 줄을 남기지 않는다)', async () => {
    await act(async () => { root.render(<PageHead />); });
    expect(container.innerHTML).toBe('');
  });

  it('행동만 있어도 그려지고, 설명만 있으면 행동 칸이 없다', async () => {
    await act(async () => { root.render(<PageHead actions={<button type="button">행동</button>} />); });
    expect(container.querySelector('[data-slot="ds-page-head"]')).not.toBeNull();
    expect(container.querySelector('p')).toBeNull();
    await act(async () => { root.render(<PageHead description="설명" />); });
    expect(container.querySelector('[data-slot="ds-page-head-actions"]')).toBeNull();
  });

  it('폰에서는 설명 아래로 내려오고(flex-col) 넓은 화면에서 오른쪽(sm:flex-row · justify-between)', async () => {
    await act(async () => { root.render(<PageHead description="설명" actions={<span>a</span>} />); });
    const cls = container.querySelector('[data-slot="ds-page-head"]')!.className;
    for (const c of ['flex-col', 'sm:flex-row', 'sm:justify-between']) expect(cls).toContain(c);
  });
});
