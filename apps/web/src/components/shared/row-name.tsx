import { cn } from '@/lib/utils';
import { splitRowLabel } from '@/lib/member-display';

/**
 * [SID:4311 PR 3 · 유나 잘림 순서] 꼬리 붙은 행 라벨(«송윤재 · e75ca548»)을 좁은 한 줄에 — **이름만 잘리고(min-w-0 truncate) 꼬리는 늘 보인다
 * (shrink-0)**. 꼬리가 바로 동명이인을 가르는 글자라, 한 덩어리 truncate면 긴 이름에서 꼬리가 말줄임에 먹혔다(유나 1440 판 줄 실측).
 * - 글자(textContent)는 라벨 그대로 — 읽는 글자 · 접근 이름 · 기존 글자 대조는 무변.
 * - 곁글(요약 · 동사 등)이 같은 줄에 있으면 호출부가 곁글에 `min-w-0 truncate shrink-[999]`를 줘 곁글 → 이름 순으로 잘리게.
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
