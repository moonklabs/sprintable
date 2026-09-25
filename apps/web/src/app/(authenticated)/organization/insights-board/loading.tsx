// story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — loading.tsx가 없는 탭 · 메뉴 목적지는 누른 뒤 서버 응답(RSC 450~670ms)을 다 받을 때까지
// 화면이 안 바뀌었다(«탭→주소» 536~1000ms · 있는 결재 · 대화는 44~193ms). 결재(inbox/loading.tsx)와 같은 문법의 스켈레톤으로 즉시 반응.
// organization/ 전체에 한 파일로 두지 않는 이유: organization/connectors/page.tsx가 서버 redirect()를 쓴다(스트리밍 경계 아래 redirect() =
// React 오류 310 · story #3915) — 메뉴 목적지 화면마다 둔다.
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton variant="cards" className="mx-auto w-full max-w-6xl space-y-6 p-6" />;
}
