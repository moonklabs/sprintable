// @vitest-environment jsdom
//
// story 4831 — 운영자 모양의 글 칸 · 선택 칸이 날 태그가 아니라 바탕 Textarea · Select 위에 얹혀 있고(OperatorInput처럼), 운영자 모양(높이 · 최소 높이 · 화살표 · 테두리)이 부품 기본을 이기며
// 네이티브 동작(쓴 글이 onChange로 · 고른 값이 onChange로 · 자식 option)이 그대로인지 결과로 잠근다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OperatorInput, OperatorSelect, OperatorTextarea } from './operator-control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const tokens = (el: Element) => el.className.split(/\s+/);

describe('OperatorTextarea — 바탕 Textarea 위(story 4831)', () => {
  it('바탕 Textarea이고 운영자 최소 높이(min-h-[96px])가 부품의 min-h-16을 이기며, 쓴 글이 onChange로 간다', async () => {
    const onChange = vi.fn();
    await act(async () => { root.render(<OperatorTextarea rows={3} placeholder="메모" onChange={(e) => onChange(e.target.value)} />); });
    const el = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(el.dataset.slot).toBe('textarea');
    expect(el.rows).toBe(3);
    expect(tokens(el)).toContain('min-h-[96px]');
    expect(tokens(el)).not.toContain('min-h-16');
    expect(tokens(el)).toContain('resize-y');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, '한 줄 메모');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('한 줄 메모');
  });
});

describe('OperatorSelect — 바탕 Select 위(story 4831)', () => {
  it('바탕 Select이고 운영자 모양(h-10 · appearance-none · pr-10)을 갖고 있으며, 자식 option을 그리고 고른 값이 onChange로 간다', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <OperatorSelect defaultValue="a" onChange={(e) => onChange(e.target.value)}>
          <option value="a">가</option>
          <option value="b">나</option>
        </OperatorSelect>,
      );
    });
    const el = container.querySelector('select') as HTMLSelectElement;
    expect(el.dataset.slot).toBe('select');
    for (const t of ['h-10', 'appearance-none', 'pr-10']) expect(tokens(el), t).toContain(t);
    expect(tokens(el)).not.toContain('h-9'); // 부품 기본 높이를 운영자 높이가 이긴다
    expect([...el.options].map((o) => o.value)).toEqual(['a', 'b']);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, 'b');
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('OperatorInput — 이미 바탕 Input 위(기준)', () => {
  it('바탕 Input이고 운영자 높이(h-10)가 부품의 h-9를 이긴다', async () => {
    await act(async () => { root.render(<OperatorInput placeholder="이름" />); });
    const el = container.querySelector('input') as HTMLInputElement;
    expect(el.dataset.slot).toBe('input');
    expect(tokens(el)).toContain('h-10');
    expect(tokens(el)).not.toContain('h-9');
  });
});
