// @vitest-environment jsdom
//
// story 4831 (바탕 한 벌 규격 v1 §5) — 날것 <textarea> · <select> · checkbox · radio · 손 팝오버의 자리가 되는 바탕 부품 다섯.
// 지키는 것: ① 입력 계열(Textarea · Select)은 Input과 같은 글자 규칙(모바일 16px · lg 14px — iPhone 확대 방지, story #4410)을 실제 Tailwind 캐스케이드로 폭마다 잰다
// ② 초점 링이 Input과 같은 시트론 ③ Checkbox · RadioGroup이 실제로 상태를 바꾼다 ④ Popover가 열리고 Esc로 닫힌다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Textarea } from './textarea';
import { Select } from './select';
import { Checkbox } from './checkbox';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { Popover, PopoverTrigger, PopoverContent } from './popover';
import { loadTailwindCascade } from '@/components/docs/lib/tailwind-cascade.test-helper';

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

function toPx(value: string): number {
  const m = /^([\d.]+)(px|rem)$/.exec(value.trim());
  if (!m) throw new Error(`font-size를 px로 못 바꿈: «${value}»`);
  return m[2] === 'rem' ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!);
}

describe('Textarea · Select — Input과 같은 글자 규칙', () => {
  it.each([
    [390, 16],
    [800, 16],
    [1280, 14],
  ])('⭐Textarea 폭 %ipx → %ipx', async (width, px) => {
    await act(async () => { root.render(<Textarea aria-label="t" />); });
    const el = container.querySelector('textarea')!;
    const cascade = await loadTailwindCascade(container, { viewportWidth: width });
    expect(cascade.unparsable()).toEqual([]);
    expect(toPx(cascade.computed(el, 'font-size', 'light'))).toBe(px);
  });

  it.each([
    [390, 16],
    [800, 16],
    [1280, 14],
  ])('⭐Select 폭 %ipx → %ipx', async (width, px) => {
    await act(async () => { root.render(<Select aria-label="t"><option value="a">a</option></Select>); });
    const el = container.querySelector('select')!;
    const cascade = await loadTailwindCascade(container, { viewportWidth: width });
    expect(toPx(cascade.computed(el, 'font-size', 'light'))).toBe(px);
  });

  it('초점 링이 Input과 같은 proof-citron이다', async () => {
    await act(async () => { root.render(<><Textarea aria-label="a" /><Select aria-label="b" /></>); });
    for (const el of [container.querySelector('textarea')!, container.querySelector('select')!]) {
      expect(el.className).toContain('focus-visible:border-proof-citron');
      expect(el.className).toContain('focus-visible:ring-proof-citron');
    }
  });

  it('값 · 속성이 그대로 전달된다(날것 자리를 대신할 수 있다)', async () => {
    await act(async () => {
      root.render(<><Textarea aria-label="a" defaultValue="내용" rows={3} /><Select aria-label="b" defaultValue="b"><option value="a">a</option><option value="b">b</option></Select></>);
    });
    expect(container.querySelector('textarea')!.value).toBe('내용');
    expect(container.querySelector('textarea')!.rows).toBe(3);
    expect(container.querySelector('select')!.value).toBe('b');
  });
});

describe('Checkbox', () => {
  it('눌러서 켜고 끈다(aria-checked가 바뀐다)', async () => {
    let last: boolean | undefined;
    await act(async () => { root.render(<Checkbox aria-label="동의" onCheckedChange={(v) => { last = v; }} />); });
    const el = container.querySelector('[data-slot="checkbox"]') as HTMLElement;
    expect(el.getAttribute('aria-checked')).toBe('false');
    await act(async () => { el.click(); });
    expect(last).toBe(true);
    expect(el.getAttribute('aria-checked')).toBe('true');
    await act(async () => { el.click(); });
    expect(el.getAttribute('aria-checked')).toBe('false');
  });

  it('비활성이면 눌러도 안 바뀐다', async () => {
    await act(async () => { root.render(<Checkbox aria-label="동의" disabled />); });
    const el = container.querySelector('[data-slot="checkbox"]') as HTMLElement;
    await act(async () => { el.click(); });
    expect(el.getAttribute('aria-checked')).toBe('false');
  });

  it('⭐비활성 표시는 Base UI가 노출하는 data-disabled에 걸려 있다(disabled: 변형은 비-네이티브 루트에서 안 먹는다)', async () => {
    await act(async () => { root.render(<><Checkbox aria-label="a" disabled /><RadioGroup aria-label="r"><RadioGroupItem value="x" aria-label="x" disabled /></RadioGroup></>); });
    for (const el of [container.querySelector('[data-slot="checkbox"]')!, container.querySelector('[data-slot="radio-group-item"]')!]) {
      expect(el.hasAttribute('data-disabled')).toBe(true);
      expect(el.className).toContain('data-disabled:opacity-50');
      expect(el.className).toContain('data-disabled:cursor-not-allowed');
      expect(el.className).not.toMatch(/(^|\s)disabled:/);
    }
  });
});

describe('RadioGroup', () => {
  it('하나를 고르면 나머지는 꺼진다', async () => {
    let value: unknown;
    await act(async () => {
      root.render(
        <RadioGroup aria-label="수신" defaultValue="a" onValueChange={(v) => { value = v; }}>
          <RadioGroupItem value="a" aria-label="a" />
          <RadioGroupItem value="b" aria-label="b" />
        </RadioGroup>,
      );
    });
    const [a, b] = Array.from(container.querySelectorAll('[data-slot="radio-group-item"]')) as HTMLElement[];
    expect(a!.getAttribute('aria-checked')).toBe('true');
    expect(b!.getAttribute('aria-checked')).toBe('false');
    await act(async () => { b!.click(); });
    expect(value).toBe('b');
    expect(a!.getAttribute('aria-checked')).toBe('false');
    expect(b!.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Popover', () => {
  it('트리거로 열고 Esc로 닫는다', async () => {
    await act(async () => {
      root.render(
        <Popover>
          <PopoverTrigger>열기</PopoverTrigger>
          <PopoverContent><p>안내</p></PopoverContent>
        </Popover>,
      );
    });
    expect(document.body.textContent).not.toContain('안내');
    await act(async () => { (container.querySelector('[data-slot="popover-trigger"]') as HTMLElement).click(); });
    expect(document.body.textContent).toContain('안내');
    const content = document.querySelector('[data-slot="popover-content"]') as HTMLElement;
    expect(content.className).toContain('shadow-[var(--elev-overlay)]');
    expect(content.className).toContain('ring-proof-line-strong');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.body.textContent).not.toContain('안내');
  });
});
