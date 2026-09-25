// @vitest-environment jsdom
// story #4316(PO 14:30Z) — 하네스 자체의 양성 · 음성 대조. 하네스는 jsdom 한계(var 미해석 · 이스케이프 클래스 선택자 거부)를 별칭 클래스 · 자체 캐스케이드로
// 우회하므로 틀릴 수 있다 — 결과를 이미 아는 자리에서 «이김 / 짐»을 제대로 뽑는지 먼저 잰다. 이 파일이 초록이어야 표를 믿는다.
import { describe, expect, it } from 'vitest';
import { loadTailwindCascade, specificity } from './tailwind-cascade.test-helper';

async function setup(html: string) {
  document.body.innerHTML = `<div id="c">${html}</div>`;
  const c = document.getElementById('c')!;
  const cascade = await loadTailwindCascade(c);
  expect(cascade.unparsable(), '하네스가 못 읽은 선택자 0').toEqual([]);
  return { cascade, $: (id: string) => document.getElementById(id)! };
}

describe('tailwind-cascade 하네스 — 대조', () => {
  it('⭐양성 대조: 뿌리 하위 선택자(`.root a` 0,1,1)는 자식의 유틸 클래스(0,1,0)를 이긴다 — 하네스가 «짐»으로 뽑음', async () => {
    const { cascade, $ } = await setup(
      '<div class="[&_a]:text-brand-soft [&_a]:underline [&_p]:text-foreground"><p id="p" class="text-muted-foreground">x</p><a id="a" class="text-muted-foreground no-underline" href="#">y</a></div>'
      + '<span id="fg" class="text-foreground">ref</span><span id="brand" class="text-brand-soft">ref</span>',
    );
    for (const theme of ['light', 'dark'] as const) {
      // p: 선언 muted인데 뿌리 [&_p]:text-foreground가 이겨 foreground(참조 요소와 같은 값) · a: 선언 muted인데 뿌리 brand-soft.
      expect(cascade.computed($('p'), 'color', theme), theme).not.toBe(cascade.declared($('p'), 'color', theme));
      expect(cascade.computed($('p'), 'color', theme), theme).toBe(cascade.computed($('fg'), 'color', theme));
      expect(cascade.computed($('a'), 'color', theme), theme).toBe(cascade.computed($('brand'), 'color', theme));
      expect(cascade.computed($('a'), 'text-decoration-line', theme), theme).toBe('underline');
      expect(cascade.declared($('a'), 'text-decoration-line', theme), theme).toBe('none');
    }
    expect(cascade.winner($('p'), 'color')).toContain('_p');
    expect(cascade.winner($('a'), 'color')).toContain('_a');
  });

  it('음성 대조: 더 구체적인 선택자(0,2,0)는 뿌리 규칙(0,1,1)을 이긴다 · 뿌리 규칙이 없으면 자기 클래스가 이긴다', async () => {
    const { cascade, $ } = await setup(
      '<div class="[&_a]:text-brand-soft"><a id="win" data-x="1" class="[&[data-x]]:text-foreground" href="#">y</a></div><p id="own" class="text-muted-foreground">z</p>'
      + '<span id="fg" class="text-foreground">ref</span><span id="brand" class="text-brand-soft">ref</span>',
    );
    for (const theme of ['light', 'dark'] as const) {
      expect(cascade.computed($('win'), 'color', theme), theme).toBe(cascade.computed($('fg'), 'color', theme));
      expect(cascade.computed($('win'), 'color', theme), theme).not.toBe(cascade.computed($('brand'), 'color', theme));
      expect(cascade.computed($('own'), 'color', theme), theme).toBe(cascade.declared($('own'), 'color', theme));
    }
    expect(cascade.winner($('win'), 'color')).toContain('data-x');
    // 두 테마가 실제로 다른 값으로 풀린다(테마 해석이 살아 있음).
    expect(cascade.computed($('own'), 'color', 'light')).not.toBe(cascade.computed($('own'), 'color', 'dark'));
  });

  // 레이어는 특이도보다 앞선다(CSS Cascade 5): globals.css `@layer components`의 `[data-sidebar="menu-button"][data-popup-open]`(0,2,0 · color)는
  // 뒤 레이어(utilities)의 `.text-foreground`(0,1,0)에 진다. 레이어를 무시하면 특이도로 components가 이겨 이 칸이 RED.
  it('레이어 순서: 앞 레이어의 더 구체적인 규칙(components 0,2,0)은 뒤 레이어의 유틸리티(utilities 0,1,0)에 진다', async () => {
    const { cascade, $ } = await setup('<button id="b" data-sidebar="menu-button" data-popup-open="" class="text-foreground">m</button><span id="fg" class="text-foreground">ref</span>');
    for (const theme of ['light', 'dark'] as const) expect(cascade.computed($('b'), 'color', theme), theme).toBe(cascade.computed($('fg'), 'color', theme));
    expect(cascade.winner($('b'), 'color')).toBe('.text-foreground');
  });

  it('밑줄 전파: 조상 밑줄은 자손 `no-underline`으로 못 지운다', async () => {
    const { cascade, $ } = await setup('<a class="underline" href="#"><span id="s" class="no-underline">t</span></a><span id="n">n</span>');
    expect(cascade.computed($('s'), 'text-decoration-line', 'light')).toBe('underline');
    expect(cascade.computed($('n'), 'text-decoration-line', 'light')).toBe('none');
  });

  it('특이도: :where = 0 · :is/:not = 인자 최대 · 이스케이프 클래스 1개', () => {
    expect(specificity('.\\[\\&_p\\]\\:text-foreground p')).toEqual([0, 1, 1]);
    expect(specificity('.a[data-x]')).toEqual([0, 2, 0]);
    expect(specificity(':where(.a, #b) p')).toEqual([0, 0, 1]);
    expect(specificity(':is(.a, #b) p')).toEqual([1, 0, 1]);
    expect(specificity('a:not(.x)')).toEqual([0, 1, 1]);
  });
});
