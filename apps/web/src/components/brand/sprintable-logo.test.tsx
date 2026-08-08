// @vitest-environment jsdom
//
// story #2529(브랜드 마크 v2 — 2단 듀오톤) 회귀가드. AC "변형 3종(stacked/horizontal/mark)·
// wordmark·className API 전부 불변"은 유지하고, 마크 지오메트리/색 검증만 v1(3단 stroke
// currentColor)→v2(2단 fill 듀오톤, tone prop)로 갱신한다.
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

describe('SprintableMark (v2 — 2단 듀오톤 fill)', () => {
  it('viewBox가 마크 v2 자연 경계(0 0 358.188 300.018)로 스왑됐다(v1의 0 0 100 100 아님)', () => {
    act(() => root.render(<SprintableMark aria-hidden="true" />));
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 358.188 300.018');
  });

  it('stroke(v1) 아닌 fill 기반 2-path로 렌더된다', () => {
    act(() => root.render(<SprintableMark aria-hidden="true" />));
    const paths = container.querySelectorAll('svg path');
    expect(paths.length).toBe(2);
    expect(paths[0]?.getAttribute('stroke')).toBeNull();
  });

  it('tone="auto"(기본)는 globals.css 토큰을 참조한다(라이트=듀오톤/다크=모노 전환)', () => {
    act(() => root.render(<SprintableMark aria-hidden="true" />));
    const paths = [...container.querySelectorAll('svg path')];
    expect(paths[0]?.getAttribute('fill')).toBe('var(--brand-mark-primary)');
    expect(paths[1]?.getAttribute('fill')).toBe('var(--brand-mark-accent)');
  });

  it('tone="mono"는 고정 흰+회 HEX로 렌더된다(항상-다크 표면 전용, 테마 무관)', () => {
    act(() => root.render(<SprintableMark aria-hidden="true" tone="mono" />));
    const paths = [...container.querySelectorAll('svg path')];
    expect(paths[0]?.getAttribute('fill')).toBe('#FFFFFF');
    expect(paths[1]?.getAttribute('fill')).toBe('#ADADAD');
  });
});

describe('SprintableTypeWordmark — Rajdhani 전용 폰트(§4)', () => {
  it('워드마크 span에 font-wordmark 유틸리티(Rajdhani, globals.css)가 적용된다', () => {
    act(() => root.render(<SprintableLogo variant="stacked" />));
    const wordmarkSpan = [...container.querySelectorAll('span')].find(
      (s) => s.textContent === 'Sprintable' && s.children.length === 0,
    );
    expect(wordmarkSpan?.className).toContain('font-wordmark');
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

  it('tone prop이 variant 3종 전부에 전파된다(horizontal/stacked/mark)', () => {
    act(() => root.render(<SprintableLogo variant="mark" tone="mono" />));
    let svg = container.querySelector('svg');
    expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('#FFFFFF');

    act(() => root.render(<SprintableLogo variant="horizontal" tone="mono" />));
    svg = container.querySelector('svg');
    expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('#FFFFFF');
  });
});
