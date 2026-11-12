'use client';

import type { ComponentProps } from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/utils';
import { FIELD_FOCUS } from './field-focus';

// 글자 크기: 폰(기본)은 16px(text-base) — iOS Safari는 16px 미만 입력칸을 누르면 화면을 확대한다(story #4410, 현행 `ui/input`과 같은 규칙). lg 이상은 본문 13(ds-body).
// `color-scheme`: 브라우저 기본 날짜 · 시간 칸의 달력 아이콘이 어두운 화면에서도 보이게 한다(앱 테마는 `.dark` 클래스라 브라우저에 따로 알려야 한다).
const FIELD =
  '[color-scheme:light] dark:[color-scheme:dark] w-full min-w-0 rounded-ds-control border border-ds-line-control bg-ds-surface-sunk px-3 text-base text-ds-ink outline-none transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none lg:text-ds-body ' +
  `placeholder:text-ds-ink-3 ${FIELD_FOCUS} ` +
  'disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-dashed disabled:bg-transparent disabled:text-ds-ink-3 ' +
  'aria-invalid:border-ds-failed';

// Base UI의 className은 «상태를 받는 함수»도 허용하지만 cn()은 함수를 조용히 버린다 — 이 부품은 문자열만 받는다(현행 ui/checkbox와 같은 약속).
export type InputProps = Omit<ComponentProps<typeof InputPrimitive>, 'className'> & { className?: string };

/**
 * UI-3(a9d56577) Input — doc §4 #3. 높이 36(폰 = coarse 포인터는 44 — 누름 영역) · `surface-sunk` 바탕 · `line-control` 경계(3:1) · 초점 = `action` 경계 + 링 · 오류(`aria-invalid`) = `failed` 경계.
 * 오류는 색만으로 말하지 않는다 — 보이는 글과 아이콘은 `Field`가 칸 아래에 붙인다(Input 혼자 쓰면 호출부가 오류 글을 준다).
 */
export function Input({ className, ...props }: InputProps) {
  return <InputPrimitive data-slot="ds-input" className={cn(FIELD, 'h-ds-control touch:h-ds-touch', className)} {...props} />;
}

export type TextareaProps = ComponentProps<'textarea'>;

/** UI-3(a9d56577) Textarea — Input과 같은 토큰 · 같은 글자 규칙, 최소 높이 64 · 세로로만 늘림. */
export function Textarea({ className, ...props }: TextareaProps) {
  return <textarea data-slot="ds-textarea" className={cn(FIELD, 'min-h-16 resize-y py-2', className)} {...props} />;
}
