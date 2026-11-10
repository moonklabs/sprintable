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
    expect(container.querySelector('button')!.className).toContain('size-7');
    expect(container.querySelector('button')!.className).toContain('pointer-coarse:min-h-11');
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" size="lg" />); });
    expect(container.querySelector('button')!.className).toContain('size-9');
  });
});
