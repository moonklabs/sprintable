import { notFound } from 'next/navigation';

// E-SETTINGS S3: 죽은 /agents/workflow 차단. page.tsx 삭제 시 (authenticated) layout 밖 루트 404가
// 잡혀 사이드바 없는 기본 404가 나옴 → S5 /meetings 처럼 thin guard 유지해야
// (authenticated)/not-found.tsx(사이드바 유지·한글·대시보드 CTA)가 일관 적용된다.
export default function Page() {
  notFound();
}
