// story #4274 — 채널 포스트 반응의 즉시 반응 스켈레톤. 4913 D물결: 위 폴더(`content/channel-posts`)의 loading.tsx가 «한 쪽 틀» 스켈레톤으로 바뀌며 이 화면이 그것을 받지 않도록 옛 스켈레톤을 따로 쥔다(이 화면은 이 판 밖 — 그대로).
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton className="mx-auto w-full max-w-5xl space-y-6 p-6" />;
}
