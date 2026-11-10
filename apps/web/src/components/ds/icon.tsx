import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';
import { ICON_PATHS, type IconName } from './icon-paths';

export type { IconName } from './icon-paths';

const DEFAULT_VIEWBOX = '0 -960 960 960';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children' | 'viewBox' | 'width' | 'height' | 'role' | 'aria-label' | 'aria-hidden'> {
  /** Material Symbols 이름(허용 목록은 icon-paths.ts — 오타는 컴파일 에러). lucide 이름 대응은 icon-map.ts. */
  name: IconName;
  /** px 정사각. 기본 16(길잡이 18 · 단추 안 14). */
  size?: number;
  /** 뜻을 싣는 아이콘만 준다(스크린리더가 읽음). 없으면 장식으로 숨긴다. role · aria-label · aria-hidden은 이 prop이 정한다(호출부가 따로 덮어쓰지 못한다). */
  label?: string;
  /** 도는 아이콘(progress_activity). prefers-reduced-motion이면 멈춘다. */
  spin?: boolean;
}

/**
 * UI-3(a9d56577) — 새 아이콘 부품. Material Symbols Outlined(채움 0 · 두께 400)를 인라인 SVG로 그린다 — 색은 `currentColor`.
 * 옛 lucide 호출은 건드리지 않는다(영역 PR이 옮길 때 갈아 끼움).
 */
export function Icon({ name, size = 16, label, spin = false, className, ...rest }: IconProps) {
  const glyph: { readonly d: string; readonly vb?: string } = ICON_PATHS[name];
  return (
    <svg
      {...rest}
      viewBox={glyph.vb ?? DEFAULT_VIEWBOX}
      width={size}
      height={size}
      fill="currentColor"
      focusable="false"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-icon={name}
      className={cn('inline-block shrink-0', spin && 'motion-safe:animate-spin', className)}
    >
      <path d={glyph.d} />
    </svg>
  );
}
