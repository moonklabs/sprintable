// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IconButton } from './icon-button';

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

describe('ds IconButton', () => {
  it('⭐글자가 없는 단추라 label이 aria-label · title이 된다', async () => {
    await act(async () => { root.render(<IconButton label="닫기" icon="close" />); });
    const b = container.querySelector('button')!;
    expect(b.getAttribute('aria-label')).toBe('닫기');
    expect(b.getAttribute('title')).toBe('닫기');
    expect(b.querySelector('[data-icon="close"]')).not.toBeNull();
  });

  it('크기 28 / 36 · 폰 누름 영역 44', async () => {
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" />); });
    expect(container.querySelector('button')!.className).toContain('size-ds-control-sm');
    expect(container.querySelector('button')!.className).toContain('touch:min-h-ds-touch');
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" size="lg" />); });
    expect(container.querySelector('button')!.className).toContain('size-ds-control');
  });

  it('⭐주 모양 primary: action 면 · 글 on-action · 비활성은 점선 윤곽 · 이름(label)은 그대로 필수', async () => {
    await act(async () => { root.render(<IconButton label="새 대화" icon="add" variant="primary" size="xl" />); });
    const b = container.querySelector('button')!;
    expect(b.className).toMatch(/(^|\s)bg-ds-action(\s|$)/);
    expect(b.className).toMatch(/(^|\s)text-ds-on-action(\s|$)/);
    expect(b.className).toContain('disabled:border-dashed');
    expect(b.getAttribute('aria-label')).toBe('새 대화');
  });

  it('⭐크기 xl 48(떠 있는 단추) · 폰 누름 44 이상 · 기본 변형은 quiet(면 없음)', async () => {
    await act(async () => { root.render(<IconButton label="새 대화" icon="add" size="xl" />); });
    const b = container.querySelector('button')!;
    expect(b.className).toContain('size-ds-control-xl');
    expect(b.className).toContain('touch:min-h-ds-touch');
    expect(b.className).not.toMatch(/(^|\s)bg-ds-action(\s|$)/);
    expect(b.querySelector('svg')!.getAttribute('width')).toBe('22');
  });

  it('⭐비활성 primary는 native disabled · aria-disabled(focusableWhenDisabled) 둘 다 활성 색을 잃는다', async () => {
    await act(async () => { root.render(<IconButton label="새 대화" icon="add" variant="primary" disabled />); });
    const cls = container.querySelector('button')!.className;
    for (const p of ['disabled', 'aria-disabled']) {
      expect(cls, p).toContain(`${p}:bg-transparent`);
      expect(cls, p).toContain(`${p}:border-dashed`);
      expect(cls, p).toContain(`${p}:brightness-100`);
      expect(cls, p).toContain(`${p}:pointer-events-none`);
    }
  });
});
