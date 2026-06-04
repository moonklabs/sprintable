import { notFound } from 'next/navigation';

// E-SETTINGS S5: Meetings 진입 차단(옵션 A). 클라이언트 컴포넌트는 보존(reversible) — page만 thin guard.
export default function Page() {
  notFound();
}
