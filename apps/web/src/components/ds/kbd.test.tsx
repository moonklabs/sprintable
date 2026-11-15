// UI-3(a9d56577) — ds Kbd: 키 이름은 글 그대로 읽히고 고정폭 칸이다.
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
import { Kbd } from './kbd';

describe('ds Kbd', () => {
  it('⭐kbd 요소 · 글 그대로 · 고정폭 칸', async () => {
    await render(<Kbd>⌘K</Kbd>);
    const el = container.querySelector('kbd') as HTMLElement;
    expect(el.textContent).toBe('⌘K');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('rounded-ds-tag');
    expect(el.getAttribute('aria-hidden')).toBeNull();
  });
});
