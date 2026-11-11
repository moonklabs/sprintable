import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type SkeletonVariant = 'rect' | 'text' | 'circle';
export type SkeletonTextSize = 'small' | 'body' | 'card-title' | 'title';

// 글 한 줄의 «자리 높이» = 그 글 크기의 줄 높이(12/16 · 13/20 · 14/20 · 18/24) — 실제 글로 바뀔 때 화면이 밀리지 않는다. 막대는 그 안 가운데(위아래 여백은 배경을 안 칠한다).
function textBox(size: SkeletonTextSize): string {
  // 객체 표 대신 분기 — `{ title: '…' }` 꼴은 «화면 문자열 영어 문장 스캔»(verify:no-hardcoded-english-ui-message)이 사람용 속성으로 오인한다.
  if (size === 'small') return 'h-4 py-[3px]';
  if (size === 'title') return 'h-6 py-1.5';
  return 'h-5 py-1';
}

// 접근성 속성(aria-hidden · role · aria-live)은 부품이 정한다 — 호출부가 덮어쓰면 막대마다 읽히거나(aria-hidden=false) 묶음의 한 마디가 사라진다(타입에서 뺀다 + 펼친 뒤에 둔다).
export interface SkeletonProps extends Omit<HTMLAttributes<HTMLElement>, 'aria-hidden' | 'role' | 'aria-live' | 'aria-busy'> {
  variant?: SkeletonVariant;
  /** `text` 변형의 글 크기 — 자리 높이가 그 글의 줄 높이가 된다. 기본 `body`. */
  size?: SkeletonTextSize;
  /** 문장 요소(<p> 등) 안에 둘 때 `span` — <p> 안의 <div>는 HTML 파서가 <p>를 쪼갠다(현행 `ui/skeleton`과 같은 이유). */
  as?: 'div' | 'span';
}

/**
 * UI-3(a9d56577) Skeleton — doc v0.3 #29. 막대 `surface-high` · 2초 숨쉬기(`motion-safe`만 — 움직임 줄이기면 멈춘 막대). 장식이라 `aria-hidden`이고,
 * «불러오는 중»이라는 말은 묶음(`SkeletonGroup`)이 한 번만 한다. 색 · 모서리는 새 토큰만(현행 `ui/skeleton`의 shimmer 변수는 안 쓴다).
 */
export function Skeleton({ variant = 'rect', size = 'body', as: Tag = 'div', className, ...rest }: SkeletonProps) {
  // 타입에서 뺀 접근성 속성이 런타임에 들어와도 버린다(JS 호출 · 단언) — 부품이 정한 값만 남는다.
  const { 'aria-hidden': _h, role: _r, 'aria-live': _l, 'aria-busy': _b, ...props } = rest as typeof rest & Record<string, unknown>;
  return (
    <Tag
      data-slot="ds-skeleton"
      data-variant={variant}
      className={cn(
        'block bg-ds-surface-high motion-safe:animate-pulse',
        variant === 'rect' && 'rounded-ds-control',
        variant === 'text' && cn('w-full rounded-ds-control bg-clip-content', textBox(size)),
        variant === 'circle' && 'aspect-square rounded-full',
        Tag === 'span' && 'inline-block',
        className,
      )}
      {...props}
      aria-hidden="true"
    />
  );
}

export interface SkeletonGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-busy' | 'aria-label' | 'aria-labelledby' | 'aria-live' | 'aria-hidden'> {
  /** «불러오는 중» 같은 말 — 필수(스크린리더가 이 한 마디만 읽는다). */
  label: string;
}

/** 막대 묶음 — `role=status` + `aria-busy` + 이름 하나. 안의 막대는 모두 장식이다. */
export function SkeletonGroup({ label, className, children, ...rest }: SkeletonGroupProps) {
  const { role: _r, 'aria-busy': _b, 'aria-label': _l, 'aria-labelledby': _lb, 'aria-live': _lv, 'aria-hidden': _h, ...props } = rest as typeof rest & Record<string, unknown>;
  return (
    <div data-slot="ds-skeleton-group" className={className} {...props} role="status" aria-busy="true" aria-label={label}>
      {children}
    </div>
  );
}
