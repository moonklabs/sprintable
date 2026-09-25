/**
 * story a539c649(S-route-project) S1 — workspace/project slug 단일 resolve(BE story ddac96fd,
 * `GET /api/v2/resolve?workspace=&project=`) 소비 유틸. proxy.ts(Edge 미들웨어)가 쓴다.
 *
 * S1 스코프(오르테가군 확定 2026-07-15): 이 모듈은 resolve+캐시+redirect-chase 를 완성하되,
 * **활성화는 RESERVED_FIRST_SEGMENTS 와 겹치지 않는 첫 세그먼트에만** 국한한다 — 현존 flat
 * 라우트(`/board`·`/docs`...)의 첫 세그먼트를 workspace slug 로 오인해 전면 장애가 나는 것을
 * 막는다(회귀 0). flat→path 301 은 여기서 켜지 않는다 — 목적지 페이지(`/{ws}/{proj}/{resource}`)
 * 가 아직 없어(S2/S3 몫) 301 을 걸면 즉시 404 만 유발한다. S1 은 미들웨어 단(실 ws slug 진입 시
 * resolve 성공+캐시+301-chase 동작)만 증명한다.
 */
import { SignJWT, jwtVerify } from 'jose';
import { backendSignal } from '@/lib/backend-signal';

export const SP_RESOLVE_CACHE_COOKIE = 'sp_resolve_cache';

/** 디디 실측(30~60s 판단 — slug UNIQUE 제약상 rename 즉시 재점유 가능해 긴 캐시=오배정 리스크,
 * "느려서"가 아니다). BE Cache-Control max-age=60s 보다 여유 두고 하회. */
export const RESOLVE_CACHE_TTL_SECONDS = 50;

export { RESERVED_FIRST_SEGMENTS, looksLikeWorkspaceSegment } from './reserved-first-segments';

export interface ResolvedContext {
  orgId: string;
  orgSlug: string;
  orgRole: string;
  projectId?: string;
  projectSlug?: string;
}

interface ResolveApiResponse {
  org_id: string;
  org_slug: string;
  org_role: string;
  project_id?: string;
  project_slug?: string;
  redirect?: { workspace?: string; project?: string };
}

export type ResolveOutcome =
  | { kind: 'ok'; context: ResolvedContext }
  | { kind: 'redirect'; workspace?: string; project?: string }
  | { kind: 'not_found' };

function getResolveCacheSecret(): Uint8Array {
  const secret = process.env['JWT_SECRET'] ?? '';
  return new TextEncoder().encode(secret);
}

/**
 * 캐시 쿠키 서명 — resolve 응답을 HttpOnly JWT 로 감싸 위조 불가+만료(exp) 자연 처리(proxy.ts
 * 기존 sp_at/sp_rt 와 동일 JWT_SECRET 재사용 — 신규 시크릿 프로비저닝 불요).
 *
 * ⚠️보안 경계(PO 승인 확定 — 회귀 방지 고정): 이 쿠키의 org_role 은 **UX 라우팅 힌트일 뿐 권한
 * 판단이 아니다.** BE mutation 은 여전히 x-project-id/x-org-id 헤더를 서버측에서 독립
 * 재검증한다 — 이 캐시가 위조/오염돼도 실 데이터 변경은 막힌다. TTL(50s) 중 접근권이 회수돼도
 * UX 라우팅만 최대 50s 지연 반영·실 데이터는 BE 서버검증이 즉시 차단하므로 안전(디디
 * 30~60s 판단과 정합, PO 승인 트레이드오프).
 */
export async function signResolveCache(
  wsSlug: string,
  projSlug: string | undefined,
  context: ResolvedContext,
): Promise<string> {
  return new SignJWT({ wsSlug, projSlug: projSlug ?? null, ...context })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${RESOLVE_CACHE_TTL_SECONDS}s`)
    .sign(getResolveCacheSecret());
}

/** 캐시 쿠키 검증 — 서명·만료·요청 slug 일치(URL이 바뀌었으면 캐시 무효) 전부 통과해야 hit. */
export async function verifyResolveCache(
  token: string,
  wsSlug: string,
  projSlug: string | undefined,
): Promise<ResolvedContext | null> {
  try {
    const { payload } = await jwtVerify(token, getResolveCacheSecret());
    if (payload['wsSlug'] !== wsSlug) return null;
    if ((payload['projSlug'] ?? null) !== (projSlug ?? null)) return null;
    const { orgId, orgSlug, orgRole, projectId, projectSlug } = payload;
    if (typeof orgId !== 'string' || typeof orgSlug !== 'string' || typeof orgRole !== 'string') return null;
    return {
      orgId,
      orgSlug,
      orgRole,
      ...(typeof projectId === 'string' ? { projectId } : {}),
      ...(typeof projectSlug === 'string' ? { projectSlug } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * BE 단일 resolve 엔드포인트 호출(story ddac96fd) — 캐시 미스일 때만. `redirect` 필드는 raw
 * HTTP 301 이 아니라 JSON 필드(BE 의도적 설계 — fetch() 호출 미들웨어 입장에서 조건 없는 301은
 * 왕복 낭비) — 이 함수가 그 필드를 그대로 outcome 으로 승격해, 호출부(proxy.ts)가 자체 301을
 * 낸다.
 */
export async function fetchResolve(
  fastapiUrl: string,
  wsSlug: string,
  projSlug: string | undefined,
  accessToken: string,
): Promise<ResolveOutcome> {
  const params = new URLSearchParams({ workspace: wsSlug });
  if (projSlug) params.set('project', projSlug);
  try {
    const res = await fetch(`${fastapiUrl}/api/v2/resolve?${params.toString()}`, {
      // story #4320 — 경로 해석(서버 컴포넌트 · 요청 객체 없음)이라 이 파일의 백엔드 fetch는 모두 시간 제한만(backendSignal(null)).
      signal: backendSignal(null),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { kind: 'not_found' };
    const json = await res.json() as ResolveApiResponse;
    if (json.redirect) {
      return { kind: 'redirect', workspace: json.redirect.workspace, project: json.redirect.project };
    }
    return {
      kind: 'ok',
      context: {
        orgId: json.org_id,
        orgSlug: json.org_slug,
        orgRole: json.org_role,
        ...(json.project_id ? { projectId: json.project_id } : {}),
        ...(json.project_slug ? { projectSlug: json.project_slug } : {}),
      },
    };
  } catch {
    return { kind: 'not_found' };
  }
}

/**
 * story a539c649(S-route-project, S2 최초 도입·S3 리소스 파라미터화) — 이관 완료된 리소스의
 * bare `/{resource}/*`(옛 flat URL, ws/proj 세그먼트 없음)를 위한 default 해소. JWT의
 * org_id + `sprintable_current_project_id` 쿠키(기존 "현재 project" 시스템과 동일 시맨틱
 * — 새 리스크 없음, 마이그 전에도 이 bare 링크들은 이미 이 쿠키에 암묵 의존이었다)로
 * org/project 를 슬러그로 역해소한다. 여기서 못 찾으면(예: 아직 project 미선택) null —
 * 호출부가 개입 없이 통과시켜 Next 자체 404 로 정직하게 실패한다.
 *
 * ⚠️한계(PO 승인 확定 — done-gate에 명시): 이 default 해소는 "현재 project"만 본다. 링크된
 * 엔티티가 실제로는 **다른** project 소속이면(cross-project 딥링크) 여전히 못 찾는다 — 마이그
 * 전부터 있던 기존 갭이라 회귀는 아니지만 근본 미해결. 알림/게이트/챗 등 외부 호출부가 엔티티의
 * 진짜 project를 직접 실어보내는 후속 스토리(오르테가군 등재 예정)가 근본 해법이다.
 */
export async function resolveLegacyResourcePath(
  fastapiUrl: string,
  orgId: string,
  projectId: string,
  accessToken: string,
): Promise<{ orgSlug: string; projectSlug: string; orgRole?: string; primaryVerified: boolean } | null> {
  try {
    const authHeader = { Authorization: `Bearer ${accessToken}` };
    // ⛔카디르 QA 근본 재진단(2026-08-09, 실측 8회 재현) — 이 함수의 project 조회(단건·리스트
    // 둘 다)가 X-Org-Id 없이 나가면 BE get_verified_org_id가 **JWT 기본 org**로 스코프한다.
    // 세션의 현재/타겟 org(이 함수의 orgId 파라미터)가 JWT 기본 org와 다른 멀티org 계정에선
    // 엉뚱한 org로 스코프돼 빈 결과/404가 난다(curl로 X-Org-Id 붙이면 정상 확認됨) — 위
    // 리스트 폴백 fix가 이 헤더 없이는 애초에 못 먹었던 진짜 근본원인.
    const authHeaderWithOrg = { ...authHeader, 'X-Org-Id': orgId };
    const [orgRes, projRes] = await Promise.all([
      fetch(`${fastapiUrl}/api/v2/organizations/${orgId}`, { signal: backendSignal(null), headers: authHeader }),
      fetch(`${fastapiUrl}/api/v2/projects/${projectId}`, { signal: backendSignal(null), headers: authHeaderWithOrg }),
    ]);
    if (!orgRes.ok) return null;
    // story #4219 G2 — role(가산 필드)이 오면 호출부가 /glance 307에 resolve 캐시를 심는다(옛 백엔드면 없음 → 안 심음).
    const org = await orgRes.json() as { slug?: string; role?: string | null };
    if (!org.slug) return null;

    let projectSlug = projRes.ok ? ((await projRes.json() as { slug?: string | null }).slug ?? null) : null;
    // story #4219 G2(까디르 P2) — org 단건·project 단건은 primary(get_db)라 그 판정으로만 resolve 캐시를 서명할 수 있다. 아래 목록
    // 폴백(GET /projects)은 read replica(get_read_db)라, 권한 회수 직후 replica 지연 동안 primary(/resolve)가 거절할 문맥을
    // 50초 캐시로 발급할 수 있다 → 폴백으로 찾은 결과는 primaryVerified=false(리다이렉트는 그대로 · 캐시만 안 심음).
    const primaryVerified = Boolean(projectSlug);
    // ⛔실측 결함(2026-08-09, PO puppeteer 재현 — 흐름 메뉴→/flow bare→dead-end 404) — 단건조회
    // (GET /projects/{id})가 정상 프로젝트(slug 有)인데도 이따금 slug 없이/실패 응답해 이 자리가
    // dead-end 404였다(근본원인=위 X-Org-Id 누락). 리스트 엔드포인트(GET /projects)는 같은
    // 프로젝트를 직접 대조로 항상 정확히 낸다는 걸 확認했다 — 단건조회가 비면 그 자리에서
    // 정직하게 포기하지 않고 리스트에서 안전하게 한 번 더 찾는다.
    if (!projectSlug) {
      const listRes = await fetch(`${fastapiUrl}/api/v2/projects`, { signal: backendSignal(null), headers: authHeaderWithOrg });
      if (listRes.ok) {
        const list = await listRes.json() as Array<{ id?: string; slug?: string | null }>;
        projectSlug = list.find((p) => p.id === projectId)?.slug ?? null;
      }
    }
    if (!projectSlug) return null;
    return { orgSlug: org.slug, projectSlug, primaryVerified, ...(org.role ? { orgRole: org.role } : {}) };
  } catch {
    return null;
  }
}
