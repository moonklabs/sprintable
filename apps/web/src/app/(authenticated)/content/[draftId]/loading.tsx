// story #4274 — 글 상세(`content/[draftId]`)의 즉시 반응 스켈레톤. 4913 D물결: 위 폴더의 loading.tsx가 블로그 포스트 «한 쪽 틀» 스켈레톤으로 바뀌며 이 상세가 그것을 받지 않도록 옛 스켈레톤을 따로 쥔다(상세는 이 판 밖 — 화면 그대로).
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton className="mx-auto w-full max-w-5xl space-y-6 p-6" />;
}
