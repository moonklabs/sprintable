// @vitest-environment jsdom
//
// story #4410 — iPhone은 글자가 16px 미만인 입력칸(과 편집 칸)에 초점이 가면 화면을 확대한다. 공용 Input은 모바일 16px이었지만
// `md:text-sm`이라 768~1023px(iPad 세로)에서 14px였고(코드 규칙 «md 금지 · GNB lg와 일치»와도 어긋남), 문서 편집기 본문은 15px였다.
// 실제 Tailwind 컴파일 CSS의 캐스케이드로 폭마다 잰다(story #4316 도우미 · #4406 viewportWidth).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Input } from './input';
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

describe('공용 Input 글자 크기(story #4410)', () => {
  it.each([
    [390, 16],
    [800, 16], // iPad 세로 — 예전 md:text-sm이면 14
    [1280, 14], // 데스크톱 무변
  ])('⭐폭 %ipx → %ipx', async (width, px) => {
    await act(async () => { root.render(<Input aria-label="t" />); });
    const el = container.querySelector('input')!;
    const cascade = await loadTailwindCascade(container, { viewportWidth: width });
    expect(cascade.unparsable()).toEqual([]);
    expect(toPx(cascade.computed(el, 'font-size', 'light'))).toBe(px);
  });
});

describe('문서 편집기 본문 글자 크기(story #4410)', () => {
  it.each([
    [390, 16],
    [800, 16],
    [1280, 15], // 데스크톱 무변
  ])('⭐폭 %ipx → %ipx', async (width, px) => {
    await act(async () => {
      root.render(<div className="tiptap-content"><div className="tiptap" contentEditable suppressContentEditableWarning>본문</div></div>);
    });
    const el = container.querySelector('.tiptap')!;
    const cascade = await loadTailwindCascade(container, { viewportWidth: width });
    expect(toPx(cascade.computed(el, 'font-size', 'light'))).toBe(px);
  });
});
