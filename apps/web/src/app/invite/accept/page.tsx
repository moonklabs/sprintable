import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';
import { InviteAcceptClient } from './invite-accept-client';

interface Props {
  searchParams: Promise<{ token?: string }>;
}

export default async function InviteAcceptPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!token) redirect('/');

  const session = await getServerSession().catch(() => null);
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
  }

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const inviteRes = await fetch(`${fastapiUrl}/api/v2/invites/${token}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  }).catch(() => null);

  if (!inviteRes?.ok) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-xl font-semibold text-foreground">초대가 유효하지 않습니다</h1>
          <p className="text-sm text-muted-foreground">만료됐거나 이미 사용된 초대 링크입니다.</p>
          <a href="/dashboard" className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Dashboard로 이동
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
    />
  );
}
