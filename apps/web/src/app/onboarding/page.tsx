import { OnboardingForm } from './onboarding-form';
import { redirect } from 'next/navigation';
import { desktopOnboardingNext } from '@/lib/auth/onboarding-next';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveChatsHref, resolveNavV3Destinations } from '@/lib/nav-v3-destinations';
import { EmailVerifyGate } from '@/components/auth/email-verify-gate';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';
import { afterOrgDeleted } from '@/lib/auth/org-deleted-landing';

interface OnboardingPageProps {
  searchParams: Promise<{ step?: string; orgId?: string; next?: string; after?: string }>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  // story 4711 AC4 — a sign-up that started in the desktop app (`next=/desktop/setup`) has no «조직 만들기» screen any more: the app's setup page
  // makes the organization itself, from the folder the person picks (and asks for the e-mail check there). Any other `next` is ignored; every
  // other sign-up is unchanged. `step=project` (an organization exists) is the usual onboarding.
  const desktopNext = desktopOnboardingNext(params.next);
  if (desktopNext && !params.step) redirect(desktopNext);
  // story #4453 — creating an organization needs a verified e-mail: the «verify your e-mail» gate comes first (it opens in
  // place once verified). `step=project` comes after an organization exists — no gate there.
  const initialStep = params.step === 'project' ? 'project' : undefined;
  const initialOrgId = params.orgId ?? undefined;
  // story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:44Z) — 이 page.tsx는 서버
  // 컴포넌트라 여기서 읽어 client인 OnboardingForm에 prop으로 내려준다. story #3983의
  // todayV3Enabled도 같은 flags 객체에서 뽑는다(env 축 하나로 합류 — 별도 isTodayV3Enabled()
  // 호출 0, rebase 시점 재정정 2026-09-22). todayHref도 같은 모듈에서(하드코딩 '/today' 0).
  const flags = readNavV3FlagsFromEnv();
  const chatsHref = resolveChatsHref(flags);
  const todayHref = resolveNavV3Destinations(flags).today.path;

  const form = (
    <OnboardingForm
      initialStep={initialStep}
      initialOrgId={initialOrgId}
      todayV3Enabled={flags.todayV3Enabled}
      todayHref={todayHref}
      chatsHref={chatsHref}
      macDownloadEnabled={isDesktopDownloadEnabled(process.env.DESKTOP_DOWNLOAD_ENABLED)}
      afterOrgDelete={afterOrgDeleted(params.after) && !initialStep}
    />
  );
  return initialStep === 'project' ? form : <EmailVerifyGate>{form}</EmailVerifyGate>;
}
