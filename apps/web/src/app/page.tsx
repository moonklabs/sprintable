import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';

// story #4017(PO 확定 2026-09-17) — (authenticated)/layout.tsx:148-150과 동일하게
// process.env 직접 읽기(today-v3.ts 헬퍼는 아직 develop에 없음, story #4003 주석 참고).
export default async function RootPage() {
  const session = await getServerSession();
  const todayV3Enabled = process.env['TODAY_V3_ENABLED'] === 'true';
  redirect(session ? (todayV3Enabled ? '/today' : '/org-briefing') : '/login');
}
