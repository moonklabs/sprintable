import { cn } from '@/lib/utils';
import { splitRowLabel } from '@/lib/member-display';

/**
 * [SID:4311 PR 3 · 유나 잘림 순서] 꼬리 붙은 행 라벨(«송윤재 · e75ca548»)을 좁은 한 줄에 — **이름만 잘리고(min-w-0 truncate) 꼬리는 늘 보인다
 * (shrink-0)**. 꼬리가 바로 동명이인을 가르는 글자라, 한 덩어리 truncate면 긴 이름에서 꼬리가 말줄임에 먹혔다(유나 1440 판 줄 실측).
 * - 글자(textContent)는 라벨 그대로 — 읽는 글자 · 접근 이름 · 기존 글자 대조는 무변.
 * - 곁글(요약 · 동사 등)이 같은 줄에 있으면 호출부가 곁글에 `min-w-0 flex-1 truncate`를 줘 곁글 → 이름 순으로 잘리게.
 *   `flex-1`(flex: 1 1 0%)이라 곁글 바탕이 0 — 이름은 자연 폭을 다 받고 곁글은 남는 폭만 쓴다. 줄이 이름보다 좁아져야 비로소 이름이 준다.
 *   (예전 `shrink-[999]`는 곁글 바탕이 글자 폭이라 줄어듦이 이름에도 0.05~0.14px 나뉘어, 곁글이 보이는 동안 이름 말줄임이 글자 하나를 먹었다 — 유나 390 실측.)
 * - 꼬리 앞 « · »는 flex 항목 머리 공백이 사라지지 않게 whitespace-pre.
 */
export function RowName({ label, id, className }: { label: string | undefined; id: string | null | undefined; className?: string }) {
  const { name, tail } = splitRowLabel(label ?? '', id);
  return (
    <span data-row-name="" className={cn('flex min-w-0 max-w-full items-baseline', className)}>
      <span data-row-name-part="name" className="min-w-0 truncate">{name}</span>
      {tail ? <span data-row-name-part="tail" className="shrink-0 whitespace-pre">{` · ${tail}`}</span> : null}
    </span>
  );
}
