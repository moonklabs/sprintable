// story #4274(까디르 검수 P2) — v3 플래그를 켜면 탭 · 메뉴 목적지가 이 화면으로 바뀐다(«오늘» /today · «대화» /chat · «연결·규칙» /connect-rules).
// 플래그 OFF 목적지와 같게 누른 즉시 스켈레톤으로 반응. 이 폴더의 layout.tsx(redirect 사용)는 같은 폴더 loading.tsx 경계의 **바깥**이라 오류 310과 무관.
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton />;
}
