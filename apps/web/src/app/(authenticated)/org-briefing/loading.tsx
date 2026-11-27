// story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — loading.tsx가 없는 탭 · 메뉴 목적지는 누른 뒤 서버 응답(RSC 450~670ms)을 다 받을 때까지
// 화면이 안 바뀌었다(«탭→주소» 536~1000ms · 있는 결재 · 대화는 44~193ms). 결재(inbox/loading.tsx)와 같은 문법의 스켈레톤으로 즉시 반응.
// 전체 → 오늘.
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  // story 5031 (C1 step 5c): the same container as the body root (org-briefing-shell.tsx) — it fills the inset now (no centred max-w-4xl column), so the skeleton and the screen stand in the same place
  return <PageSkeleton className="w-full space-y-6 p-4 lg:p-6" />;
}
