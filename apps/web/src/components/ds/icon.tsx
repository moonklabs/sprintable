import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';
import { ICON_GLYPHS, type IconName } from './icon-paths';

export type { IconName } from './icon-paths';

/**
 * story 5048 ④(PO 11-27) — 아이콘 크기 단계 셋. 키트는 24 하나(글 16 : 아이콘 24 = 1 : 1.5) — 우리 글 14에 대면 조작 안은 20:
 *  · `sm` 16 — 촘촘한 줄 안(13 · 14 글자 옆) · `md` 20 — 탐색 · 40 높이 조작 · 막대 단추 · `lg` 24 — 빈 화면 · 큰 머리.
 * 12 · 14는 12 글자 옆 칩 · 배지 안에서만(숫자로 직접 준다). 같은 값이 CSS 토큰 `size-ds-icon-sm|md|lg`(design-system.css)로도 있다 — lucide를 직접 쓰는 호출부가 클래스로 따른다.
 */
export const ICON_SIZE = { sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof ICON_SIZE;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children' | 'viewBox' | 'width' | 'height' | 'role' | 'aria-label' | 'aria-hidden'> {
  /** 글리프 이름(허용 목록은 icon-paths.ts — 오타는 컴파일 에러). 옛 lucide 이름 대응은 icon-map.ts. */
  name: IconName;
  /** px 정사각 또는 단계(`sm` 16 · `md` 20 · `lg` 24). 기본 16(`sm`). */
  size?: number | IconSize;
  /** 뜻을 싣는 아이콘만 준다(스크린리더가 읽음). 없으면 장식으로 숨긴다. role · aria-label · aria-hidden은 이 prop이 정한다(호출부가 따로 덮어쓰지 못한다). */
  label?: string;
  /** 도는 아이콘(progress_activity). prefers-reduced-motion이면 멈춘다. */
  spin?: boolean;
}

/**
 * 공용 아이콘 부품. story 5048 ④부터 앱의 나머지와 같은 집안 — lucide(끝 둥근 선 · 굵기 2 · 24 격자, 크기와 함께 줄어듦 · 색은 `currentColor`). 예전(UI-3)엔 Material Symbols 채움 윤곽이었다.
 */
export function Icon({ name, size = 16, label, spin = false, className, ...rest }: IconProps) {
  const Glyph = ICON_GLYPHS[name];
  const px = typeof size === 'number' ? size : ICON_SIZE[size];
  return (
    <Glyph
      {...rest}
      size={px}
      focusable="false"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-icon={name}
      className={cn('inline-block shrink-0', spin && 'motion-safe:animate-spin', className)}
    />
  );
}
