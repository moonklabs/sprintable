// @vitest-environment jsdom
//
// doc web-logo-rocket-swap-spec — 로켓-A 3-stroke 마크 교체 회귀가드. AC "변형 3종
// (stacked/horizontal/mark)·wordmark·className API 전부 불변"을 실 렌더로 고정한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SprintableLogo, SprintableMark } from './sprintable-logo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SprintableMark (로켓-A 3-stroke)', () => {
  it('viewBox가 0 0 100 100으로 스왑됐다(구 마크 430 278 164 300 아님)', () => {
    act(() => root.render(<SprintableMark aria-hidden="true" />));
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 100 100');
  });

  it('fill 기반(9-path 앰버) 아닌 stroke=currentColor 기반 3-path로 렌더된다', () => {
    act(() => root.render(<SprintableMark aria-hidden="true" />));
    const g = container.querySelector('svg > g');
    expect(g?.getAttribute('fill')).toBe('none');
    expect(g?.getAttribute('stroke')).toBe('currentColor');
    const paths = container.querySelectorAll('svg path');
    expect(paths.length).toBe(3);
  });

  it('트레일 opacity 페이드(메인 1.0·트레일1 0.6·트레일2 0.38)가 정확히 적용된다', () => {
    act(() => root.render(<SprintableMark aria-hidden="true" />));
    const paths = [...container.querySelectorAll('svg path')];
    expect(paths[0]?.getAttribute('opacity')).toBe('1');
    expect(paths[1]?.getAttribute('opacity')).toBe('0.6');
    expect(paths[2]?.getAttribute('opacity')).toBe('0.38');
  });
});

describe('SprintableLogo — 변형 3종·wordmark·className API 불변(AC)', () => {
  it('mark 변형: markClassName이 SVG에 그대로 전달된다', () => {
    act(() => root.render(<SprintableLogo variant="mark" markClassName="h-14" />));
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('h-14');
  });

  it('horizontal 변형: 마크+워드마크 둘 다 렌더되고 "Sprintable" 텍스트 유지', () => {
    act(() => root.render(<SprintableLogo variant="horizontal" />));
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toContain('Sprintable');
  });

  it('stacked 변형(기본값): 마크+워드마크 세로 배치, className API 유지', () => {
    act(() => root.render(<SprintableLogo markClassName="h-10" wordmarkClassName="h-5" />));
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('h-10');
    const wordmarkSpan = [...container.querySelectorAll('span')].find(
      (s) => s.textContent === 'Sprintable' && s.children.length === 0,
    );
    expect(wordmarkSpan?.getAttribute('class')).toContain('h-5');
  });
});
