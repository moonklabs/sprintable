import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';

/**
 * story 5048 ⑤-⑨ — 대화 목록 열이 «읽는 중»일 때의 한 모양: ds SkeletonGroup(role=status · aria-busy · 이름 = 불러오는 중 — 막대는 장식).
 * 옛: 가운데 «불러오는 중…» 글자만. 줄 모양은 `chats/loading.tsx`(길 로딩)와 같다(아바타 원 + 제목 막대 + 둘째 줄 막대) — 도착 때 목록과 어긋나 튀지 않게.
 */
export function ChatListSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <SkeletonGroup label={label} className="flex flex-col gap-1 p-2" data-testid="chat-list-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <Skeleton variant="circle" className="size-10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}
