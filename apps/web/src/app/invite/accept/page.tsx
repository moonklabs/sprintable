import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerSession } from '@/lib/db/server';
import { InviteAcceptClient } from './invite-accept-client';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveChatsHref } from '@/lib/nav-v3-destinations';

interface Props {
  searchParams: Promise<{ token?: string }>;
}

export default async function InviteAcceptPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!token) redirect('/');

  // story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:44Z) — 이 page.tsx는 서버
  // 컴포넌트라 여기서 직접 읽어, 아래 <a>와 InviteAcceptClient prop 둘 다에 쓴다.
  const chatsHref = resolveChatsHref(readNavV3FlagsFromEnv());

  const session = await getServerSession().catch(() => null);
  if (!session) {
    // story #3220 — 예전엔 `returnUrl`로 실었는데 login/page.tsx는 `next`만 읽는다(양쪽이
    // 애초에 다른 파라미터명으로 각자 짜여 한 번도 안 이어져 있었음 — 비로그인 사용자는
    // 로그인해도 여기로 못 돌아왔다). 세션-만료 redirect(session-redirect.ts)와 동일한
    // `next` 컨벤션으로 통일.
    redirect(`/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
  }

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const inviteRes = await fetch(`${fastapiUrl}/api/v2/invites/${token}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  }).catch(() => null);

  if (!inviteRes?.ok) {
    // story #3923 — 이 페이지는 next-intl이 항상 배선돼 있었다(root layout 전역
    // NextIntlClientProvider). Server Component라 useTranslations가 아니라
    // next-intl/server의 getTranslations를 쓴다(이 코드베이스 첫 사용례 —
    // useTranslations 배선 패턴의 서버측 등가물).
    const t = await getTranslations('invite');
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-xl font-semibold text-foreground">{t('linkInvalidTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('linkInvalidBody')}</p>
          {/* story #3179(S3c) — /dashboard 폐합, 홈=chat 재조준. story #4017 CHANGES 2 —
              목적지 모듈 경유(chatsHref, 동적 표현식이라 no-html-link-for-pages가 애초에
              안 걸려 옛 eslint-disable 주석은 제거). */}
          <a href={chatsHref} className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            {t('goToChatButton')}
          </a>
        </div>
      </div>
    );
  }

  // BE-direct(/api/v2/invites/{token})는 InvitePreviewResponse를 top-level로 반환(envelope 없음).
  // 프록시(/api/invites/{token})만 apiSuccess로 {data} 래핑하므로 양쪽 shape 모두 대응한다.
  type InvitePreviewData = { org_name?: string; role?: string; email?: string; projects?: { id: string; name: string }[] };
  const raw = await inviteRes.json() as InvitePreviewData & { data?: InvitePreviewData };
  const invite = raw.data ?? raw;

  return (
    <InviteAcceptClient
      token={token}
      orgName={invite.org_name ?? ''}
      role={invite.role ?? 'member'}
      email={invite.email ?? ''}
      projects={invite.projects ?? []}
      chatsHref={chatsHref}
    />
  );
}
