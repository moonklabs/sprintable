import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export type NativeSelectProps = ComponentProps<'select'>;

/**
 * UI-3(a9d56577) NativeSelect(doc #21 Select의 첫 조각) — 브라우저 기본 `<select>` 위의 얇은 껍데기(현행 `ui/select`와 같은 방침): 키보드 · 스크린리더 · 폰의 기본 선택기가 그대로 살고, `Input`과 같은 높이 36(폰 44) · 경계 · 초점 · 글자 규칙(폰 16px)만 입힌다.
 * 오른쪽 `expand_more`는 «열리는 칸»이라는 표시(장식 · 클릭 통과). 검색이 있는 목록 · 여러 개 고르기는 후속 — 그때까지는 이 부품이 «하나 고르기»를 맡는다. 이름이 `Select`가 아닌 까닭: 현행 `ui/select`와 같은 이름이면 small-text-input 가드가 «두 파일에서 래퍼 이름이 다르게 나온다»며 호출부를 정적으로 못 가린다.
 * 오류는 `Field`가 칸 아래에 글 + 아이콘으로 붙인다(`aria-invalid`는 여기서 `failed` 경계).
 */
export function NativeSelect({ className, children, ...props }: NativeSelectProps) {
  return (
    // className은 «바깥 틀»에 건다 — 폭(`w-40` 등)을 줄여도 화살표가 칸 가장자리에 붙어 따라온다(칸은 틀을 가득 채운다).
    <div data-slot="ds-select" className={cn('relative w-full min-w-0', className)}>
      <select
        className={cn(
          'h-9 pointer-coarse:h-11 w-full min-w-0 appearance-none rounded-ds-control border border-ds-line-control bg-ds-surface-sunk py-0 pr-8 pl-3 text-base text-ds-ink outline-none transition-colors duration-100 motion-reduce:transition-none lg:text-ds-body',
          'focus-visible:border-ds-action focus-visible:ring-2 focus-visible:ring-ds-action',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-dashed disabled:bg-transparent disabled:text-ds-ink-3',
          'aria-invalid:border-ds-failed aria-invalid:focus-visible:ring-ds-failed',
        )}
        {...props}
      >
        {children}
      </select>
      <Icon name="expand_more" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ds-ink-3" />
    </div>
  );
}
