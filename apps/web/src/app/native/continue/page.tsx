import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerSession } from '@/lib/db/server';
import { CONTINUE_PATH, continueQuery, parseContinueStart, startParamsFrom } from '@/lib/auth/desktop-continue';
import { DesktopContinueCard } from '@/components/desktop/desktop-continue-card';

/**
 * story 4712 — «브라우저 이어받기». The Mac app opens this page in the person's browser with its PKCE challenge (first run, no web session in
 * the app). Signed in → «<계정> 계정으로 이 컴퓨터의 앱을 열까요?» and [열기]; not signed in → the ordinary sign-in, then back here. The page itself
 * makes no code — only the button's POST does (Kadir v2 ②). It sits outside `(authenticated)` on purpose: no dashboard shell, and a brand-new
 * account with no organization yet must not be sent to onboarding from here.
 */
export default async function DesktopContinuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const q = startParamsFrom(raw); // a start parameter given twice (a list) is off, not «absent»
  const start = q && parseContinueStart(q);
  const t = await getTranslations('desktopContinue');

  if (!start) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted px-4">
        <div className="max-w-sm rounded-2xl bg-background p-8 text-center shadow-sm">
          <h1 className="mb-2 text-lg font-semibold text-foreground">{t('invalidTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('invalidBody')}</p>
        </div>
      </main>
    );
  }

  const session = await getServerSession();
  const here = `${CONTINUE_PATH}?${continueQuery(start)}`;
  if (!session) redirect(`/login?next=${encodeURIComponent(here)}`);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4">
      <DesktopContinueCard account={session.email} start={{ challenge: start.challenge, returnApp: start.returnApp }} here={here} failed={raw['failed'] === '1'} />
    </main>
  );
}
