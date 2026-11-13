// story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — 채널 포스트 목록의 즉시 반응 스켈레톤(결재 inbox/loading.tsx와 같은 문법).
// 4913 D물결: 블로그 포스트가 «한 쪽 틀»로 옮겨가며 위 폴더의 loading.tsx가 틀 스켈레톤이 됐다 — 채널 포스트는 아직 옛 화면이라 자기 옛 스켈레톤을 그대로 둔다(옮길 때 이 파일도 틀로).
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton className="mx-auto w-full max-w-5xl space-y-6 p-6" />;
}
