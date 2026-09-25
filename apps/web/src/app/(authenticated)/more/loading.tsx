// story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — loading.tsx가 없는 탭 · 메뉴 목적지는 누른 뒤 서버 응답(RSC 450~670ms)을 다 받을 때까지
// 화면이 안 바뀌었다(«탭→주소» 536~1000ms · 있는 결재 · 대화는 44~193ms). 결재(inbox/loading.tsx)와 같은 문법의 스켈레톤으로 즉시 반응.
// 전체(/more) — 메뉴 목록 모양(제목 · 줄 여럿).
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton cards={0} rows={8} />;
}
