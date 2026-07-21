import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/db/server';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';
import { DashboardShell } from '../dashboard/dashboard-shell';
import { StorageCapacityToastProvider } from '@/components/storage/storage-capacity-toast-provider';

interface MemberContext {
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
  name: string;
  role?: string;
}

interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // AC3: proxy 가 주입한 x-pathname 으로 next 보존(server component 는 현재 경로 직접 못 읽음).
  const hdrs = await headers();
  const currentPath = hdrs.get('x-pathname') ?? '';
  // story #2093 — proxy.ts(route-resolve.ts `setResolvedHeaders`)가 `[ws]/[proj]` 경로를
  // 서버측에서 이미 resolve해 실어보낸 값. 계정 상태(me.org_id/project_id)는 URL에 org/project
  // 세그먼트가 없는 flat 라우트(/glance 등)에서만 신뢰하고, 경로가 있으면 이 값이 정본이다
  // ("화면이 그리는 컨텍스트의 정본은 URL" — 유나양 규격 §2093).
  const pathOrgId = hdrs.get('x-resolved-org-id') ?? undefined;
  const pathProjectId = hdrs.get('x-resolved-project-id') ?? undefined;

  const session = await getServerSession();
  if (!session) redirect(buildLoginRedirect(currentPath));

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const authHeader = { Authorization: `Bearer ${session.access_token}` };

  const [meRes, membershipsRes, orgsRes] = await Promise.all([
    fetch(`${fastapiUrl}/api/v2/me`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
    fetch(`${fastapiUrl}/api/v2/me/memberships`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
    fetch(`${fastapiUrl}/api/v2/organizations`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
  ]);

  // 401(인증 만료)만 /login 리다이렉트, 다른 에러(500 등)는 children 렌더링 유지
  if (!meRes || meRes.status === 401) redirect(buildLoginRedirect(currentPath));

  // 🔴 org 없는 유저(신규 OAuth 가입자 등 — team_member 미생성 시 /me 404) → 온보딩으로.
  // auth/callback이 is_new_user 무관 /inbox 리다이렉트하는 결함을 layout에서 OAuth+email/pw 공통 커버
  // (org-less가 깨진 페이지 도달 자체 차단). /onboarding은 (authenticated) 밖이라 루프 없음.
  if (meRes.status === 404) redirect('/onboarding');

  // 0746aab9: /me가 403(org 전환 후 project 접근/인가 실패) 등 비-2xx면, 조용히 null 컨텍스트로
  // 렌더하지 않고 에러 경계(error.tsx)로 넘긴다. 기존 `me = meRes.ok ? ... : null`이 403/500을
  // 삼켜 DashboardShell이 org/project 컨텍스트 없이 깨진 화면을 무에러로 렌더하던 footgun 제거.
  if (!meRes.ok) {
    throw new Error(`Failed to load account context (HTTP ${meRes.status})`);
  }

  const me = (await meRes.json()) as MemberContext | null;
  if (!me?.org_id) redirect('/onboarding');
  const memberships: { projectId: string; projectName: string }[] =
    membershipsRes?.ok ? ((await membershipsRes.json()) as { projectId: string; projectName: string }[]) : [];
  let projectMemberships = memberships.length > 0
    ? memberships
    : me ? [{ projectId: me.project_id, projectName: me.project_name }] : [];

  const rawOrgs: OrgMembership[] = orgsRes?.ok ? ((await orgsRes.json()) as OrgMembership[]) : [];
  const orgMemberships = rawOrgs.map((o) => ({
    orgId: o.id,
    orgName: o.name,
    orgSlug: o.slug,
    role: o.role,
  }));

  // story #2093 — /me/memberships 는 JWT의 "현재 org" 클레임으로 스코프된다(BE
  // app/routers/me.py get_my_memberships). URL 경로가 계정 상태와 다른 org를 가리키면(cross-org
  // 딥링크·계정 상태가 stale한 경우) pathProjectId가 이 목록에 없어 표시용 이름을 못 찾는다 —
  // 단건 조회로 보강한다(전환 목록에 넣으려는 게 아니라 표시 이름 확보 목적, 실패해도 무해 —
  // top-bar 칩이 계정 상태 이름으로 폴백할 뿐 페이지 자체는 이미 경로 기준으로 정상 렌더된다).
  const pathProjectKnown = pathProjectId ? projectMemberships.some((m) => m.projectId === pathProjectId) : true;
  if (pathProjectId && !pathProjectKnown) {
    const resolvedName = await fetch(`${fastapiUrl}/api/v2/projects/${pathProjectId}`, { headers: authHeader, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { name?: string } | null) => json?.name ?? undefined)
      .catch(() => undefined);
    if (resolvedName) {
      projectMemberships = [...projectMemberships, { projectId: pathProjectId, projectName: resolvedName }];
    }
  }

  // story a539c649 S2: 사이드바/⌘K "문서" 바로가기가 /{ws}/{proj}/docs 직접 path를 만들려면
  // 현재 project의 slug가 필요 — /me/memberships는 slug를 안 실어 보내(BE 스코프 밖, FE 단독
  // 수정 범위 유지 위해 이미 존재하는 단건 조회를 재사용). 실패해도 sidebar/cmd-palette는
  // bare `/docs`로 폴백해 미들웨어 리다이렉트 안전망을 타므로 무해.
  // story #2093: pathProjectId(경로 정본) 우선 — 계정 상태가 다른 project를 가리키면 이
  // 바로가기도 화면이 실제로 보고 있는 project가 아니라 계정 상태 project로 잘못 향했다.
  const slugTargetProjectId = pathProjectId ?? me?.project_id;
  const currentProjectSlug = slugTargetProjectId
    ? await fetch(`${fastapiUrl}/api/v2/projects/${slugTargetProjectId}`, { headers: authHeader, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((json: { slug?: string | null } | null) => json?.slug ?? undefined)
        .catch(() => undefined)
    : undefined;

  return (
    <DashboardShell
      currentTeamMemberId={me?.id}
      orgId={me?.org_id}
      projectId={me?.project_id}
      projectName={me?.project_name ?? undefined}
      currentProjectSlug={currentProjectSlug}
      userName={me?.name}
      role={me?.role}
      projectMemberships={projectMemberships}
      orgMemberships={orgMemberships}
      pathOrgId={pathOrgId}
      pathProjectId={pathProjectId}
    >
      <StorageCapacityToastProvider>{children}</StorageCapacityToastProvider>
    </DashboardShell>
  );
}
