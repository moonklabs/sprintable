// @vitest-environment jsdom
// [SID:4311 PR 3 · 유나 1440 실측] RowName — 긴 이름에서도 꼬리 글자가 DOM에 온전 · 잘리는 칸(truncate)은 이름 요소에만 · 꼬리는 줄지 않음(shrink-0).
// jsdom은 폭을 재지 않는다 — 잘림 순서의 실제 픽셀은 유나 실측 몫, 여기선 구조(어느 요소가 잘리는가)를 핀으로 박는다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RowName } from './row-name';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const cls = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/);

describe('RowName([SID:4311 PR 3])', () => {
  it('긴 이름 + 꼬리: 이름 요소만 truncate · 꼬리 요소는 shrink-0 · 꼬리 글자 온전 · 글자는 라벨 그대로', async () => {
    const label = '아주긴이름의구성원님이름이더길어요 · e75ca548';
    await act(async () => { root.render(<RowName label={label} id="e75ca548-aaaa" className="text-sm" />); });
    const outer = container.querySelector('[data-row-name]')!;
    const name = outer.querySelector('[data-row-name-part="name"]')!;
    const tail = outer.querySelector('[data-row-name-part="tail"]')!;
    expect(outer.textContent).toBe(label);
    expect(name.textContent).toBe('아주긴이름의구성원님이름이더길어요');
    expect(tail.textContent).toBe(' · e75ca548');
    expect(cls(name)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(cls(tail)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-pre']));
    expect(cls(tail)).not.toContain('truncate');
    expect(cls(outer)).not.toContain('truncate');
    expect(tail.closest('.truncate'), '꼬리는 어떤 truncate 요소 안에도 없다').toBeNull();
    expect(cls(outer)).toEqual(expect.arrayContaining(['flex', 'min-w-0', 'text-sm']));
  });

  it('꼬리 없는 라벨은 이름 요소 하나 · 라벨 없음(받는 중)은 빈 글자', async () => {
    await act(async () => { root.render(<RowName label="안나" id="m-anna" />); });
    expect(container.querySelector('[data-row-name-part="tail"]')).toBeNull();
    expect(container.textContent).toBe('안나');
    await act(async () => { root.render(<RowName label={undefined} id="m-anna" />); });
    expect(container.textContent).toBe('');
  });
});
