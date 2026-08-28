import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/db/server';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';
import { resolveProjectMemberships } from '@/lib/resolve-project-memberships';
import { DashboardShell } from '../dashboard/dashboard-shell';
import { StorageCapacityToastProvider } from '@/components/storage/storage-capacity-toast-provider';
import { CrossProjectToastProvider } from '@/components/chat/cross-project-toast-provider';
import { AuUsageBanner } from '@/ee/components/billing/au-usage-banner';

interface MemberContext {
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
  name: string;
  role?: string;
  // story #2103 — BE가 여러 write action(게이트/HITL 승인·거부, 각종 삭제)을 "휴먼 멤버만
  // 가능"으로 명시적으로 403 거부한다. FE가 이 판정을 미리 반영하지 않고 버튼을 무조건
  // 노출한 자리(HITL 인라인 승인/반려, approvals-queue.tsx)가 #2091(게이트 상세)과 같은
  // 버그클래스로 확인됐다 — 계정의 human/agent 여부를 앱 전역에서 재사용 가능하게
  // DashboardContext로 흘려보낸다(신규 fetch 0, 이미 매 요청 fetch하던 /api/v2/me 재사용).
  type?: 'human' | 'agent';
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
  // story #2885 — sentinel(0-프로젝트 org) 오염 가드, 근거는 resolve-project-memberships.ts 참고.
  let projectMemberships = resolveProjectMemberships(memberships, me);

  const rawOrgs: OrgMembership[] = orgsRes?.ok ? ((await orgsRes.json()) as OrgMembership[]) : [];
  const orgMemberships = rawOrgs.map((o) => ({
    orgId: o.id,
    orgName: o.name,
    orgSlug: o.slug,
    role: o.role,
  }));

  // story #2093 — /me/memberships 는 JWT의 "현재 org" 클레임으로 스코프된다(BE
  // app/routers/me.py get_my_memberships). URL 경로가 계정 상태와 다른 org를 가리키면(cross-org
  // 딥링크·계정 상태가 stale한 경우) pathProjectId가 이 목록에 없어 표시용 이름을 못 찾는다.
  // 단건 조회(name+slug 동시)로 보강한다 — 사이드바/⌘K "문서" 바로가기 slug(story a539c649 S2)
  // 와 표시 이름이 같은 project를 가리키므로 PO 리뷰(§확認②) 지적대로 fetch 하나로 합쳤다.
  // pathProjectId가 없으면(flat 라우트) 계정 상태 project 기준으로 조회한다(기존 동작 유지).
  // ⛔카디르 QA 근본 재진단(2026-08-09, 실측 8회 재현) — 아래 project 조회(단건·리스트 둘 다)를
  // X-Org-Id 없이 부르면 BE get_verified_org_id가 **JWT 기본 org**로 스코프한다. 세션의
  // 현재/타겟 org(pathOrgId ?? me.org_id)가 JWT 기본 org와 다른 멀티org 계정에선 엉뚱한
  // org로 스코프돼 빈 결과/404가 난다(curl로 X-Org-Id 붙이면 정상 확認됨) — 이게 사이드바
  // bare-link 결함의 진짜 근본원인.
  const projectAuthHeader = { ...authHeader, 'X-Org-Id': pathOrgId ?? me?.org_id ?? '' };
  const projectInfoTargetId = pathProjectId ?? me?.project_id;
  const projectInfo = projectInfoTargetId
    ? await fetch(`${fastapiUrl}/api/v2/projects/${projectInfoTargetId}`, { headers: projectAuthHeader, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((json: { name?: string; slug?: string | null } | null) => json)
        .catch(() => null)
    : null;
  // ⛔실측 결함(2026-08-09, PO puppeteer 재현 — 흐름 메뉴→/flow bare→dead-end 404) — 위 단건조회
  // (GET /projects/{id})가 정상 프로젝트(slug 有)인데도 이따금 slug 없이/실패 응답해 사이드바가
  // slug 없는 bare 링크만 만들었다(근본원인=위 X-Org-Id 누락). 리스트 엔드포인트(GET /projects)는
  // 같은 프로젝트를 직접 대조로 항상 정확히 낸다는 걸 확認했다 — 단건조회가 비면 그 자리에서
  // 포기하지 않고 리스트에서 한 번 더 찾는다.
  const projectInfoFallback = projectInfoTargetId && !projectInfo?.slug
    ? await fetch(`${fastapiUrl}/api/v2/projects`, { headers: projectAuthHeader, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((list: Array<{ id?: string; name?: string; slug?: string | null }> | null) =>
          list?.find((p) => p.id === projectInfoTargetId) ?? null)
        .catch(() => null)
    : null;
  const currentProjectSlug = projectInfo?.slug ?? projectInfoFallback?.slug ?? undefined;
  const projectInfoName = projectInfo?.name ?? projectInfoFallback?.name;

  const pathProjectKnown = pathProjectId ? projectMemberships.some((m) => m.projectId === pathProjectId) : true;
  if (pathProjectId && !pathProjectKnown && projectInfoName) {
    projectMemberships = [...projectMemberships, { projectId: pathProjectId, projectName: projectInfoName }];
  }
  // PO 리뷰(§확認①) — 위 조회가 실패하면(네트워크·403 등) projectMemberships에 pathProjectId가
  // 안 들어간다. dashboard-shell.tsx가 이 경우 계정 상태의 옛 project_name으로 조용히
  // 폴백하지 않도록 `projectName` prop 자체를 pathProjectId 미스매치 시 넘기지 않는다 —
  // 틀린 이름을 보여주느니 이름을 비워 칩이 org만 보여주게 한다(유나양 §1-1: 모르면
  // 단정하지 않는다).
  const projectNameForDisplay = (!pathProjectId || pathProjectId === me?.project_id)
    ? (me?.project_name ?? undefined)
    : undefined;

  return (
    <DashboardShell
      currentTeamMemberId={me?.id}
      orgId={me?.org_id}
      // story #2545(카디르 라이브 재QA, 2026-08-10) — `me?.org_id`는 JWT `app_metadata.org_id`
      // 클레임(#2544가 "top-level org_id"라 부른 바로 그 필드 — backend/app/dependencies/
      // auth.py의 `jwt_org_id = auth.claims.get("app_metadata", {}).get("org_id")`와 동일
      // 필드. "top-level"은 app_metadata *안에서* org_id가 최상위라는 뜻이지, JWT payload
      // 자체의 최상위 필드라는 뜻이 아니다 — 오해 소지가 있어 명시한다)가 아니라, `/api/v2/me`가
      // (주로) `app_metadata.project_id` 클레임으로 찾은 TeamMember 행의 org다
      // (backend/app/routers/me.py). 두 클레임이 갈리면(예: org_id는 reset됐는데 project_id는
      // 옛 org를 여전히 가리키는 부분-stale JWT) me.org_id가 «이미 pathOrgId와 같다»고
      // 잘못 보고해 아래 자동 switch-org effect가 조기 return — 그 순간 실제 서명된
      // app_metadata.org_id 클레임은 여전히 다르다(카디르 실측).
      // getServerSession()이 이미 jwtVerify로 이 클레임을 직접 읽어둔 값을 그대로 흘려보낸다
      // (신규 fetch/디코드 0) — DashboardShell의 불일치 판정은 이 값을 우선한다.
      jwtOrgId={session.org_id ?? undefined}
      projectId={me?.project_id}
      projectName={projectNameForDisplay}
      currentProjectSlug={currentProjectSlug}
      userName={me?.name}
      role={me?.role}
      currentMemberType={me?.type}
      projectMemberships={projectMemberships}
      orgMemberships={orgMemberships}
      pathOrgId={pathOrgId}
      pathProjectId={pathProjectId}
    >
      <StorageCapacityToastProvider>
        <CrossProjectToastProvider>
          <AuUsageBanner />
          {children}
        </CrossProjectToastProvider>
      </StorageCapacityToastProvider>
    </DashboardShell>
  );
}
