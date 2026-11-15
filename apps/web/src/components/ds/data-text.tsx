import { Fragment, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * 4928 DataText — 글 속 «데이터 조각»만 고정폭으로(시각 · 이메일 · 호스트 이름 · 영문 키 · 해시 · 번호).
 * 한국어 이름 · 상태 · 설명은 본문 글꼴 — 고정폭 칸은 한글 낱말 사이를 2.4배로 벌린다(dev 26화면 720곳 · 칸마다 +3.9px).
 * 숫자 칸 맞춤은 `tabular-nums`. 칩 전체가 데이터면 `Chip mono`, 글 속 한 조각이면 이 부품.
 */
export function DataText({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="ds-data-text" className={cn('font-mono tabular-nums', className)} {...props} />;
}

/** 둘째 줄 조각들을 « · »로 잇는다 — 조각마다 글꼴이 달라도(본문 글 · DataText) 구분점은 본문 글꼴이다. 글 모양은 `parts.join(' · ')`과 같다. */
export function joinDot(parts: ReactNode[]): ReactNode[] {
  return parts.map((part, i) => <Fragment key={i}>{i > 0 ? ' · ' : null}{part}</Fragment>);
}
