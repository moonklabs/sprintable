// @vitest-environment jsdom
//
// story #2969 §2 sidebar 행(doc proofline-system-layer-2969) — 활성 메뉴 항목에 시트론
// 좌측 엣지(PR-3, border-l-2 border-l-proof-citron) + carbon fill(유나 확定, 이 소PR —
// sidebar-active-fill/-foreground, 테마 무관 고정 다크 톤·"generic shadcn 결" 갈음).
// SidebarProvider 없이 순수 cva 함수만 단위 테스트(sidebar.tsx 전체 마운트는 컨텍스트
// 의존이 커서 다른 사이드바 테스트들과 동형으로 이 파일에서 격리).
import { describe, expect, it } from 'vitest';
import { sidebarMenuButtonVariants } from './sidebar';

describe('sidebarMenuButtonVariants — 시트론 엣지 + carbon fill(story #2969)', () => {
  it('기본 상태는 border-l-transparent(레이아웃 시프트 방지 자리 예약)', () => {
    const classes = sidebarMenuButtonVariants({});
    expect(classes).toContain('border-l-2');
    expect(classes).toContain('border-l-transparent');
  });

  it('활성(data-active) 상태는 border-l-proof-citron으로 색이 들어온다', () => {
    const classes = sidebarMenuButtonVariants({});
    expect(classes).toContain('data-active:border-l-proof-citron');
  });

  it('활성 상태는 carbon fill 배경+light 텍스트를 갖는다(유나 확定, generic shadcn 결 갈음)', () => {
    const classes = sidebarMenuButtonVariants({});
    expect(classes).toContain('data-active:bg-sidebar-active-fill');
    expect(classes).toContain('data-active:text-sidebar-active-fill-foreground');
    expect(classes).not.toContain('data-active:bg-sidebar-accent');
    expect(classes).not.toContain('data-active:text-sidebar-accent-foreground');
  });

  it('hover/열림 상태는 여전히 기존 sidebar-accent를 쓴다(활성 상태만 시그니처, 회귀 0)', () => {
    const classes = sidebarMenuButtonVariants({});
    expect(classes).toContain('hover:bg-sidebar-accent');
    expect(classes).toContain('data-open:hover:bg-sidebar-accent');
  });
});
