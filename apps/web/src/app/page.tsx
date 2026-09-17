import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveNavV3Destinations } from '@/lib/nav-v3-destinations';

// story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:31Z) — env 읽기는
// readNavV3FlagsFromEnv() 한 곳으로, 목적지 문자열은 resolveNavV3Destinations() 한
// 곳으로만 — 여기서 '/today'·'/org-briefing' 리터럴을 다시 조립하지 않는다.
export default async function RootPage() {
  const session = await getServerSession();
  redirect(session ? resolveNavV3Destinations(readNavV3FlagsFromEnv()).today.path : '/login');
}
