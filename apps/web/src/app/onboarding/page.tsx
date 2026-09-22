import { OnboardingForm } from './onboarding-form';
import { isTodayV3Enabled } from '@/lib/today-v3';

interface OnboardingPageProps {
  searchParams: Promise<{ step?: string; orgId?: string }>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  const initialStep = params.step === 'project' ? 'project' : undefined;
  const initialOrgId = params.orgId ?? undefined;

  // story #3983(PO 확定 2026-09-17 01:41Z) — OnboardingForm은 'use client'라
  // process.env를 브라우저에서 못 읽는다(NEXT_PUBLIC_ 접두 없이는 클라 번들에
  // 안 실린다) — 이 서버 컴포넌트에서 한 번 읽어 내려준다.
  return <OnboardingForm initialStep={initialStep} initialOrgId={initialOrgId} todayV3Enabled={isTodayV3Enabled()} />;
}
