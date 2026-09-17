import { OnboardingForm } from './onboarding-form';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveChatsHref } from '@/lib/nav-v3-destinations';

interface OnboardingPageProps {
  searchParams: Promise<{ step?: string; orgId?: string }>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  const initialStep = params.step === 'project' ? 'project' : undefined;
  const initialOrgId = params.orgId ?? undefined;
  // story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:44Z) — 이 page.tsx는 서버
  // 컴포넌트라 여기서 읽어 client인 OnboardingForm에 prop으로 내려준다.
  const chatsHref = resolveChatsHref(readNavV3FlagsFromEnv());

  return <OnboardingForm initialStep={initialStep} initialOrgId={initialOrgId} chatsHref={chatsHref} />;
}
