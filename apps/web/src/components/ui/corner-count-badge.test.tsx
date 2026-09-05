// @vitest-environment jsdom
//
// story #3431(공용) — 아이콘 우상단 오버레이 카운트 배지 단위 테스트. notification-bell.tsx·
// team-presence-toggle.tsx 두 복사본을 이 컴포넌트 하나로 통합했다 — 모양(원형·10px·
// tabular-nums)은 공유하고 색(variant)만 소비처가 고른다.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CornerCountBadge } from './corner-count-badge';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

describe('CornerCountBadge', () => {
  it('destructive variant — bg-destructive+테마별 반전 텍스트(라이트 흰색·다크 proof-bg)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CornerCountBadge variant="destructive" value="99+" className="absolute -right-0.5 -top-0.5" />); });
    const el = container.querySelector('span');
    expect(el?.textContent).toBe('99+');
    expect(el?.className).toContain('bg-destructive');
    expect(el?.className).toContain('text-white');
    expect(el?.className).toContain('dark:text-proof-bg');
  });

  it('info variant — bg-info+info-foreground(이미 테마별 값을 가진 기존 토큰)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CornerCountBadge variant="info" value={7} className="absolute -right-0.5 -top-0.5" />); });
    const el = container.querySelector('span');
    expect(el?.textContent).toBe('7');
    expect(el?.className).toContain('bg-info');
    expect(el?.className).toContain('text-info-foreground');
  });

  // story #3431 — 그라운딩 중 발견한 3번째 복사본(mobile-tab-bar.tsx)용 variant.
  // primary=info와 같은 토큰(--proof-blue)이라 대비는 별도 재계산 불요(주석 참고).
  it('primary variant — bg-primary+primary-foreground(mobile-tab-bar 소비)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CornerCountBadge variant="primary" value={9} className="absolute -top-1 left-full ml-0.5" />); });
    const el = container.querySelector('span');
    expect(el?.textContent).toBe('9');
    expect(el?.className).toContain('bg-primary');
    expect(el?.className).toContain('text-primary-foreground');
  });

  // story #3431 AC4 — 9px는 본문 최소(11~12px)보다 작았다. 10px로 올리되 두 소비처가
  // 갈라지지 않도록(과거 9px vs 10px 드리프트의 재발 방지) 값 하나로 고정한다.
  it('크기는 10px·원형(rounded-full·h-4·min-w-4)으로 고정 — 소비처가 각자 못 정한다', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CornerCountBadge variant="destructive" value={1} className="absolute -right-0.5 -top-0.5" />); });
    const el = container.querySelector('span');
    expect(el?.className).toContain('text-[10px]');
    expect(el?.className).toContain('rounded-full');
    expect(el?.className).toContain('h-4');
    expect(el?.className).toContain('min-w-4');
    expect(el?.className).not.toContain('text-[9px]');
    expect(el?.className).not.toContain('font-mono');
  });

  it('aria-hidden — 접근성 이름은 소비처의 버튼 aria-label이 이미 낸다(배지 자체는 장식)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CornerCountBadge variant="info" value={3} className="absolute -right-0.5 -top-0.5" />); });
    const el = container.querySelector('span');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
  });

  it('className을 병합한다(소비처의 위치 override 등)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CornerCountBadge variant="info" value={3} className="ml-auto" />); });
    const el = container.querySelector('span');
    expect(el?.className).toContain('ml-auto');
    expect(el?.className).toContain('bg-info');
  });
});
