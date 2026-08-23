// @vitest-environment jsdom
//
// story #2969 §2 PR-3(doc proofline-system-layer-2969) — Input focus를 시트론으로(이
// 컴포넌트 한정, 전역 --ring/proof-blue 무변경).
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Input } from './input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: React.ReactNode): Promise<{ el: HTMLElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return { el: container.firstElementChild as HTMLElement, root };
}

describe('Input — focus 시트론(story #2969 PR-3)', () => {
  it('focus-visible 보더/링이 proof-citron이다', async () => {
    const { el } = await mount(<Input placeholder="x" />);
    expect(el.className).toContain('focus-visible:border-proof-citron');
    expect(el.className).toContain('focus-visible:ring-proof-citron');
    expect(el.className).not.toContain('focus-visible:ring-ring');
  });
});
