// @vitest-environment jsdom
// UI-3(a9d56577) — ds TreeRow 회귀가드: 줄 전체가 하나의 단추 · 깊이 들여쓰기 · 폴더(aria-expanded + 화살표 글리프) / 잎 정렬 · 선택(aria-current=page) · 이모지/아이콘/상태 · 오른쪽 행동(HOVER_REVEAL) · 끌기 손잡이 자리 · 단추 속성 통과(미리보기/컨텍스트 메뉴/data-*) · 트리 역할 없음.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TreeRow, treeIndentPx } from './tree-row';
import { HOVER_REVEAL } from '@/lib/hover-reveal';

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
const row = () => container.querySelector('[data-slot="ds-tree-row"]') as HTMLElement;
const ctl = () => row().querySelector(':scope > button') as HTMLButtonElement;
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);

describe('ds TreeRow', () => {
  it('⭐줄 전체가 하나의 단추다 — 아이콘 · 상태 · 제목이 그 안에 있고 높이 36 · 폰 44', async () => {
    await render(<TreeRow depth={0} title="문서" icon="description" statusMark={<i data-testid="st" />} />);
    expect(ctl().tagName).toBe('BUTTON');
    expect(ctl().getAttribute('type')).toBe('button');
    expect(ctl().querySelector('[data-icon="description"]')).not.toBeNull();
    expect(ctl().querySelector('[data-testid="st"]')).not.toBeNull();
    expect(ctl().textContent).toBe('문서');
    expect(has(ctl(), 'min-h-9')).toBe(true);
    // 폰 누름 영역 44는 ds Button이 쥔 값(touch:min-h-11)을 그대로 — 줄 모양이 지우지 않는다.
    expect(has(ctl(), 'touch:min-h-11')).toBe(true);
    expect(has(ctl(), 'min-h-0')).toBe(false);
    expect(has(ctl(), 'w-full')).toBe(true);
  });

  it('⭐깊이당 16px(표 그대로) · 8단을 넘으면 맨 끝에서 멈추고 · 음수는 0 — treeIndentPx도 같은 표', async () => {
    const pad = async (d: number) => { await render(<TreeRow depth={d} title="문서" />); return ctl().className.split(/\s+/).find((c) => /^pl-\d+$/.test(c)); };
    expect(await pad(0)).toBe('pl-2');
    expect(await pad(1)).toBe('pl-6');
    expect(await pad(3)).toBe('pl-14');
    expect(await pad(8)).toBe('pl-34');
    expect(await pad(20)).toBe('pl-34');
    expect(await pad(-2)).toBe('pl-2');
    expect([0, 1, 3, 8, 20, -2].map(treeIndentPx)).toEqual([0, 16, 48, 128, 128, 0]);
    await render(<TreeRow depth={4} title="문서" />);
    expect(row().getAttribute('data-depth')).toBe('4');
  });

  it('⭐폴더 줄(expanded가 있음): 단추에 aria-expanded · 접힘 chevron_right / 펼침 expand_more 글리프 · 잎 줄은 aria-expanded 없음', async () => {
    await render(<TreeRow depth={0} title="기획" icon="folder" expanded={false} />);
    expect(ctl().getAttribute('aria-expanded')).toBe('false');
    expect(ctl().querySelector('[data-icon="chevron_right"]')).not.toBeNull();
    await render(<TreeRow depth={0} title="기획" icon="folder_open" expanded />);
    expect(ctl().getAttribute('aria-expanded')).toBe('true');
    expect(ctl().querySelector('[data-icon="expand_more"]')).not.toBeNull();
    expect(ctl().querySelector('[data-icon="folder_open"]')).not.toBeNull();
    await render(<TreeRow depth={0} title="문서" icon="description" />);
    expect(ctl().hasAttribute('aria-expanded')).toBe(false);
  });

  it('⭐잎 줄은 화살표 자리를 폴더 줄과 같은 크기(14px)로 비워 제목이 줄을 맞춘다 — 폰에서도 같은 폭', async () => {
    await render(<TreeRow depth={1} title="문서" />);
    const gap = ctl().querySelector('[data-slot="ds-tree-arrow-gap"]') as HTMLElement;
    expect(has(gap, 'size-3.5')).toBe(true);
    await render(<TreeRow depth={1} title="폴더" expanded={false} />);
    expect(ctl().querySelector('[data-slot="ds-tree-arrow-gap"]')).toBeNull();
    expect(ctl().querySelector('svg')!.getAttribute('width')).toBe('14');
  });

  it('⭐선택(열린 문서)은 줄 단추에 aria-current=page · 옅은 action 면, 아닌 줄은 없다', async () => {
    await render(<TreeRow depth={0} title="문서" selected />);
    expect(ctl().getAttribute('aria-current')).toBe('page');
    expect(has(ctl(), 'bg-ds-action-soft')).toBe(true);
    await render(<TreeRow depth={0} title="문서" />);
    expect(ctl().hasAttribute('aria-current')).toBe(false);
    expect(has(ctl(), 'bg-ds-action-soft')).toBe(false);
  });

  it('⭐지금 트리에 없는 트리 역할(role=tree · treeitem)을 얹지 않는다', async () => {
    await render(<TreeRow depth={0} title="문서" expanded />);
    expect(container.querySelector('[role="tree"], [role="treeitem"], [role="group"]')).toBeNull();
  });

  it('이모지는 아이콘 대신 장식으로', async () => {
    await render(<TreeRow depth={0} title="문서" emoji="📌" icon="description" />);
    expect(row().querySelector('[data-slot="ds-tree-emoji"]')!.getAttribute('aria-hidden')).toBe('true');
    expect(row().querySelector('[data-icon="description"]')).toBeNull();
  });

  it('⭐안으로 놓기: 옅은 면 + 안쪽 테두리(둘째 축) + data-drop-zone', async () => {
    await render(<TreeRow depth={0} title="폴더" expanded dropZone="into" />);
    expect(ctl().getAttribute('data-drop-zone')).toBe('into');
    expect(has(ctl(), 'ring-1')).toBe(true);
    expect(has(ctl(), 'ring-inset')).toBe(true);
    await render(<TreeRow depth={0} title="폴더" expanded />);
    expect(ctl().hasAttribute('data-drop-zone')).toBe(false);
  });

  it('⭐before · after도 data-drop-zone으로 남고(지금 문서 트리의 세 값) 면 · 테두리는 입히지 않는다(삽입선은 호출부)', async () => {
    for (const z of ['before', 'after'] as const) {
      await render(<TreeRow depth={1} title="문서" dropZone={z} />);
      expect(ctl().getAttribute('data-drop-zone')).toBe(z);
      expect(has(ctl(), 'ring-1')).toBe(false);
      expect(has(ctl(), 'bg-ds-action-soft')).toBe(false);
    }
  });

  it('⭐폰: 줄 단추 오른쪽 여백이 44 누름 영역 «⋮»를 비켜 간다(pr-14 = 56 ≥ right-2 8 + 44) — 마우스는 pr-10', async () => {
    await render(<TreeRow depth={0} title="아주 긴 문서 이름" trailing={<button type="button" aria-label="더보기" className="touch:size-11">⋮</button>} />);
    expect(has(ctl(), 'pr-10')).toBe(true);
    expect(has(ctl(), 'touch:pr-14')).toBe(true);
  });

  it('⭐오른쪽 행동은 줄 오른쪽 끝에 얹히고(줄 단추는 그만큼 pr-10) 공용 HOVER_REVEAL — 호버 없는 기기에서는 늘 보이고 마우스에서만 호버 · 초점 때 드러난다', async () => {
    await render(<TreeRow depth={0} title="문서" trailing={<button type="button" aria-label="더보기">⋮</button>} />);
    const t = row().querySelector('[data-slot="ds-tree-trailing"]') as HTMLElement;
    for (const c of HOVER_REVEAL.split(' ')) expect(has(t, c), c).toBe(true);
    expect(has(t, 'absolute')).toBe(true);
    expect(has(t, 'right-2')).toBe(true);
    expect(has(t, 'hidden')).toBe(false);
    expect(has(row(), 'group')).toBe(true);
    expect(has(ctl(), 'pr-10')).toBe(true);
    expect(t.querySelector('button')!.getAttribute('aria-label')).toBe('더보기');
    await render(<TreeRow depth={0} title="문서" />);
    expect(row().querySelector('[data-slot="ds-tree-trailing"]')).toBeNull();
  });

  it('⭐끌기 손잡이는 줄 왼쪽 깊이 자리에 얹히고 마우스 호버 때만 · 터치에는 없다 — 단추 위에 겹쳐 있어 줄 클릭을 막지 않는다', async () => {
    await render(<TreeRow depth={2} title="문서" dragHandle={<span data-testid="grip" />} />);
    const h = row().querySelector('[data-slot="ds-tree-handle"]') as HTMLElement;
    expect(h.querySelector('[data-testid="grip"]')).not.toBeNull();
    expect(has(h, 'pointer-events-none')).toBe(true);
    // 마우스 전용 손잡이는 «기기 분류»로만 숨긴다 — touch:(앱 셸 표지 포함)를 쓰면 앱 안 블루투스 마우스에서도 사라진다.
    expect(has(h, 'pointer-coarse:hidden')).toBe(true);
    expect(has(h, '[@media(hover:none)]:hidden')).toBe(true);
    expect(has(h, 'touch:hidden')).toBe(false);
    expect(has(h, 'opacity-0')).toBe(true);
    expect(has(h, 'pointer-fine:group-hover:opacity-100')).toBe(true);
    expect((h.firstElementChild as HTMLElement).className).toContain('w-8');
    await render(<TreeRow depth={2} title="문서" />);
    expect(row().querySelector('[data-slot="ds-tree-handle"]')).toBeNull();
  });

  it('⭐줄 단추 속성(onClick · onContextMenu · 마우스 들어옴/나감 · data-*)이 단추에 닿고 줄 뿌리 속성(ref · style · data-*)은 뿌리에 닿는다', async () => {
    const onClick = vi.fn(); const onEnter = vi.fn(); const onLeave = vi.fn(); const onCtx = vi.fn();
    let got: HTMLElement | null = null;
    await render(
      <TreeRow
        depth={0}
        title="문서"
        ref={(n: HTMLDivElement | null) => { got = n; }}
        data-sortable="x"
        data-drop-target="yes"
        style={{ opacity: 0.5 }}
        controlProps={{ onClick, onContextMenu: onCtx, onMouseEnter: onEnter, onMouseLeave: onLeave, 'data-doc-id': 'd1' } as never}
      />,
    );
    expect(got).toBe(row());
    expect(row().getAttribute('data-sortable')).toBe('x');
    expect(row().getAttribute('data-drop-target')).toBe('yes');
    expect(row().style.opacity).toBe('0.5');
    expect(ctl().getAttribute('data-doc-id')).toBe('d1');
    await act(async () => { ctl().click(); });
    await act(async () => { ctl().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => { ctl().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    await act(async () => { ctl().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    expect([onClick, onCtx, onEnter, onLeave].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it('제목은 한 줄 말줄임', async () => {
    await render(<TreeRow depth={0} title="아주 긴 문서 제목" />);
    const s = ctl().querySelector('span.truncate') as HTMLElement;
    expect(s.textContent).toBe('아주 긴 문서 제목');
    expect(has(s, 'min-w-0')).toBe(true);
  });
});
