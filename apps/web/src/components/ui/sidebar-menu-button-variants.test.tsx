// @vitest-environment jsdom
//
// story #2969 §2 PR-3(doc proofline-system-layer-2969) — 활성 메뉴 항목에 시트론 좌측
// 엣지(border-l-2 border-l-proof-citron). "carbon" 배경 축은 확定 토큰이 없어 이 PR
// 범위 밖(유나 확認 필요, PR 본문에 플래그) — 여기서는 확定된 시트론 엣지만 고정한다.
// SidebarProvider 없이 순수 cva 함수만 단위 테스트(sidebar.tsx 전체 마운트는 컨텍스트
// 의존이 커서 다른 사이드바 테스트들과 동형으로 이 파일에서 격리).
import { describe, expect, it } from 'vitest';
import { sidebarMenuButtonVariants } from './sidebar';

describe('sidebarMenuButtonVariants — 시트론 엣지(story #2969 PR-3)', () => {
  it('기본 상태는 border-l-transparent(레이아웃 시프트 방지 자리 예약)', () => {
    const classes = sidebarMenuButtonVariants({});
    expect(classes).toContain('border-l-2');
    expect(classes).toContain('border-l-transparent');
  });

  it('활성(data-active) 상태는 border-l-proof-citron으로 색이 들어온다', () => {
    const classes = sidebarMenuButtonVariants({});
    expect(classes).toContain('data-active:border-l-proof-citron');
  });
});
