// @vitest-environment jsdom
// UI-3(a9d56577) — Icon 부품 + lucide → Material Symbols 대응표 회귀가드.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Icon } from './icon';
import { ICON_PATHS } from './icon-paths';
import { LUCIDE_TO_MATERIAL } from './icon-map';

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

describe('Icon', () => {
  it('이름의 글리프 경로를 currentColor 인라인 SVG로 그린다(기본 16px)', async () => {
    await act(async () => { root.render(<Icon name="check" />); });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(ICON_PATHS.check.d);
    expect(svg.getAttribute('data-icon')).toBe('check');
  });

  it('label이 없으면 장식(aria-hidden) · 있으면 뜻을 싣는 img', async () => {
    await act(async () => { root.render(<Icon name="close" />); });
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('svg')!.getAttribute('role')).toBeNull();
    await act(async () => { root.render(<Icon name="close" label="닫기" size={18} />); });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('닫기');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.getAttribute('width')).toBe('18');
  });

  it('⭐호출부가 aria-hidden · role · aria-label을 따로 덮어쓰지 못한다(접근성 계약은 label 한 곳)', async () => {
    const loose = { 'aria-hidden': false, role: 'presentation', 'aria-label': '덮어쓰기' } as unknown as Record<string, never>;
    await act(async () => { root.render(<Icon name="close" {...loose} />); });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBeNull();
  });

  it('spin은 motion-safe로만 돈다(움직임 줄이기 존중)', async () => {
    await act(async () => { root.render(<Icon name="progress_activity" spin />); });
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('motion-safe:animate-spin');
    await act(async () => { root.render(<Icon name="progress_activity" />); });
    expect(container.querySelector('svg')!.getAttribute('class')).not.toContain('animate-spin');
  });

  it('격자가 다른 글리프(auto_awesome)는 자기 viewBox를 쓴다', async () => {
    await act(async () => { root.render(<Icon name="auto_awesome" />); });
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 24 24');
  });
});

describe('icon-paths · icon-map', () => {
  it('글리프 경로가 모두 비어 있지 않은 SVG path이고 숫자 · 명령만 가진다', () => {
    for (const [name, g] of Object.entries(ICON_PATHS)) {
      expect(g.d, name).toMatch(/^[Mm][-\d.,\sMmLlHhVvCcSsQqTtAaZz]+$/);
    }
  });

  it('⭐lucide 199종이 전부 대응되고, 모든 값이 글리프 표에 있다', () => {
    expect(Object.keys(LUCIDE_TO_MATERIAL)).toHaveLength(200);
    const missing = Object.entries(LUCIDE_TO_MATERIAL).filter(([, v]) => !(v in ICON_PATHS));
    expect(missing).toEqual([]);
  });

  it('develop에서 새로 생긴 아이콘(MessagesSquare → forum)도 대응된다', () => {
    expect(LUCIDE_TO_MATERIAL.MessagesSquare).toBe('forum');
  });

  it('상위 쓰임 몇 개의 대응이 doc대로다(Loader2 → progress_activity · Check → check · Bot → smart_toy · User → person)', () => {
    expect(LUCIDE_TO_MATERIAL.Loader2).toBe('progress_activity');
    expect(LUCIDE_TO_MATERIAL.Check).toBe('check');
    expect(LUCIDE_TO_MATERIAL.Bot).toBe('smart_toy');
    expect(LUCIDE_TO_MATERIAL.User).toBe('person');
  });
});
