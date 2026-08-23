// @vitest-environment jsdom
//
// story #2969 §2 PR-3(doc proofline-system-layer-2969) — line variant 활성 언더라인을
// 시트론으로, default variant 활성 shadow-sm 제거.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Tabs, TabsList, TabsTrigger } from './tabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: React.ReactNode): Promise<{ el: HTMLElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return { el: container.firstElementChild as HTMLElement, root };
}

describe('TabsTrigger — 시트론 언더라인 + shadow 제거(story #2969 PR-3)', () => {
  it('언더라인 의사요소(after)가 proof-citron이다', async () => {
    const { el } = await mount(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const trigger = el.querySelector('[data-slot="tabs-trigger"]');
    expect(trigger?.className).toContain('after:bg-proof-citron');
    expect(trigger?.className).not.toContain('after:bg-foreground');
  });

  it('default variant 활성 shadow-sm 클래스가 없다', async () => {
    const { el } = await mount(
      <Tabs defaultValue="a">
        <TabsList variant="default">
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const trigger = el.querySelector('[data-slot="tabs-trigger"]');
    expect(trigger?.className).not.toContain('data-active:shadow-sm');
  });
});
