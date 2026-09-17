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
  // 컴포넌트라 여기서 읽어 client인 OnboardingForm에 prop으로 내려준다. story #3983의
  // todayV3Enabled도 같은 flags 객체에서 뽑는다(env 축 하나로 합류 — 별도 isTodayV3Enabled()
  // 호출 0, rebase 시점 재정정 2026-09-22).
  const flags = readNavV3FlagsFromEnv();
  const chatsHref = resolveChatsHref(flags);

  return (
    <OnboardingForm
      initialStep={initialStep}
      initialOrgId={initialOrgId}
      todayV3Enabled={flags.todayV3Enabled}
      chatsHref={chatsHref}
    />
  );
}
