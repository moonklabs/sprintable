// story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — loading.tsx가 없는 탭 · 메뉴 목적지는 누른 뒤 서버 응답(RSC 450~670ms)을 다 받을 때까지
// 화면이 안 바뀌었다(«탭→주소» 536~1000ms · 있는 결재 · 대화는 44~193ms). 결재(inbox/loading.tsx)와 같은 문법의 스켈레톤으로 즉시 반응.
// 이 한 파일이 일감(flow) · 작업 목록 · 산출물 · 에픽 · 가설 등 프로젝트 자원 전부의 경계(자기 loading.tsx가 있는 문서 · 목표 · 실행 ·
// 스토리지는 그쪽이 우선). 이 아래 page.tsx는 서버 redirect() 없이 notFound()만 쓴다(스트리밍 경계 아래 redirect()는 React 오류 310 — story #3915).
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton />;
}
