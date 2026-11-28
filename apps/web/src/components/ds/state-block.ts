import { cn } from '@/lib/utils';

/**
 * story 5048 ⑤ — 빈 상태 · 에러 «칸을 채우는» 상태 부품이 같이 쓰는 뼈대(가운데 정렬 · 아이콘 → 제목 → 설명 → 행동). 한 곳에서만 정해서 둘이 어긋나지 않는다.
 * `inline` = 목록 «사이»에 끼는 짧은 칸(위아래 16), 기본 = 화면 한가운데(위아래 40). 로딩은 부품이 아니라 `SkeletonGroup` 규칙이다(PO 11-27).
 */
export function stateBlockClass(inline: boolean, className?: string): string {
  return cn('flex flex-col items-center gap-2 px-6 text-center', inline ? 'py-4' : 'py-10', className);
}
