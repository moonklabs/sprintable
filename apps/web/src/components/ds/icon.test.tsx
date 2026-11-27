// @vitest-environment jsdom
// UI-3(a9d56577) — Icon 부품 + lucide ↔ 이름 대응표 회귀가드. story 5048 ④(PO 11-27: «한 집안 = lucide»): 글리프는 lucide 컴포넌트(끝 둥근 선 · 굵기 2 · 24 격자) — 예전 Material 경로 시험은 «lucide 선 아이콘이다» 시험으로 바뀜.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Icon, ICON_SIZE } from './icon';
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
  it('이름의 글리프를 lucide 선 아이콘(24 격자 · 굵기 2 · 끝 둥글게 · currentColor)으로 그린다(기본 16px)', async () => {
    await act(async () => { root.render(<Icon name="check" />); });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2'); // 키트 캡처를 눈으로 읽은 값(PO) — 1.5로 깎지 않는다
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-linejoin')).toBe('round');
    expect(svg.getAttribute('data-icon')).toBe('check');
  });

  it('⭐크기 단계: sm 16 · md 20 · lg 24 — 단계 이름과 숫자 둘 다 받는다(ICON_SIZE가 한 곳)', async () => {
    expect(ICON_SIZE).toEqual({ sm: 16, md: 20, lg: 24 });
    for (const [step, px] of Object.entries(ICON_SIZE)) {
      await act(async () => { root.render(<Icon name="check" size={step as keyof typeof ICON_SIZE} />); });
      expect(container.querySelector('svg')!.getAttribute('width'), step).toBe(String(px));
    }
    await act(async () => { root.render(<Icon name="check" size={14} />); });
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('14');
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
});

describe('icon-paths · icon-map', () => {
  it('⭐글리프 표의 모든 이름이 그려진다 — lucide 선 아이콘(path · line · circle 등 자식이 있는 svg)', async () => {
    for (const name of Object.keys(ICON_PATHS)) {
      await act(async () => { root.render(<Icon name={name as keyof typeof ICON_PATHS} />); });
      const svg = container.querySelector('svg')!;
      expect(svg.children.length, name).toBeGreaterThan(0);
      expect(svg.getAttribute('stroke'), name).toBe('currentColor');
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
