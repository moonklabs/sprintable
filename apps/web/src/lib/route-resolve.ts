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
import { MIGRATED_RESOURCES, RENAMED_RESOURCES, RETIRED_RESOURCES } from './legacy-resource-tables';

export const SP_RESOLVE_CACHE_COOKIE = 'sp_resolve_cache';

/** 디디 실측(30~60s 판단 — slug UNIQUE 제약상 rename 즉시 재점유 가능해 긴 캐시=오배정 리스크,
 * "느려서"가 아니다). BE Cache-Control max-age=60s 보다 여유 두고 하회. */
export const RESOLVE_CACHE_TTL_SECONDS = 50;

/**
 * story #2393(2026-08-01) — 예전엔 아래 전부(레거시 리소스명 포함)가 "2026-07-15 grounding"
 * 손 스냅샷 하나였다. story #2387이 같은 병(proxy.ts의 RENAMED_RESOURCE_ALIASES가 손 스냅샷
 * 이라 리소스 표가 바뀌어도 안 따라옴)을 CI 가드 둘에서 고치며, 이 셋째는 «런타임 미들웨어
 * 라우팅이 직접 쓰는 값»이라 리스크가 다르다는 이유로 후속 스토리로 남겼다(PR #2774) — 이
 * 스토리가 그 후속이다.
 *
 * AC1 실측(2026-08-01, 코드 대조) — 손 스냅샷이 이미 6곳 어긋나 있었다:
 *   ㉠`gates`·`more` — app/(authenticated)/ 밑에 실존하는 라이브 라우트인데 목록에 없었다.
 *     이 둘이 워크스페이스 slug로 오인되면(리스크: 어떤 조직이 우연히 그 이름의 워크스페이스를
 *     만들면 그 조직 사용자의 `/gates`·`/more` 요청이 실제 결재함/더보기 페이지 대신 워크스페이스
 *     resolve 시도로 가로채진다) — 이번 판이 고치는 이유가 바로 이 자리다.
 *   ㉡`apple-icon.png`·`manifest.webmanifest` — Next.js 메타데이터 파일 컨벤션이 실제로 그
 *     경로에 라우트를 만든다(`pnpm build` 라우트 표로 직접 확認 — `manifest.ts`가 소스인데
 *     서빙 경로는 파일명과 다른 `manifest.webmanifest`라는 것도 이번에 확認, story #2022가
 *     인증 미들웨어 matcher에서 이미 한 번 겪은 것과 같은 함정).
 *   ㉢`flow`·`goals` — `MIGRATED_RESOURCES`(proxy.ts의 bare-flat-URL 표)엔 있는데 여기 없었다.
 *     정상 경로에선 `redirectLegacyResourcePath`가 먼저 가로채 실질 영향이 없지만, 그 함수가
 *     이른 `return null`로 통과시키는 예외 경로(예: JWT에 org_id가 없는 경우, 있음 기록된
 *     스토리 없이 이론상 가능)에서는 이 표까지 내려와야 안전하다.
 *
 * ⭐AC2 — 완전 자동파생은 하지 않는다(AC3 근거). 아래 두 갈래로 나눈 이유:
 *   ①레거시 리소스명(MIGRATED_RESOURCES∪RENAMED_RESOURCES∪RETIRED_RESOURCES 키)은 순수 데이터
 *     참조라 여기서 직접 import해 파생한다 — proxy.ts가 route-resolve.ts를 import하므로 반대
 *     방향 import는 순환참조가 되고, 그래서 이 표들을 어느 쪽도 참조하지 않는 leaf 모듈
 *     (`legacy-resource-tables.ts`)로 뺐다(proxy.ts는 거기서 import + 재수출). 이 부분은
 *     스냅샷이 아니라 항상-동기화되는 참조라 «어긋날 수 없다».
 *   ②라이브 top-level 페이지 라우트 + 메타데이터 파일 라우트는 `readdirSync`로 파생시키지
 *     않는다 — 이 파일은 proxy.ts(Next.js 미들웨어)에 import돼 **edge 런타임 번들에 들어간다**
 *     (`export const config = {...}`의 matcher가 있는 그 파일). CI 스크립트(`scripts/verify-
 *     no-orphan-resource-routes.ts`)는 Node.js 프로세스로 도니 `readdirSync`가 안전하지만,
 *     여기서 모듈 최상단에 `readdirSync`를 넣으면 edge 런타임(node:fs 미지원)에서 빌드/배포가
 *     깨질 위험을 진다 — 실 요청 라우팅을 다루는 이 파일에서 그 위험을 질 이유가 없다(PO
 *     지적과 동일 근거: "틀리면 사용자 요청이 다른 데로 간다"). 그래서 이 부분은 손 스냅샷으로
 *     «남긴다»(AC3) — 대신 `scripts/verify-reserved-first-segments-sync.ts`(신규 CI 가드)가
 *     이 목록과 실제 `app/` 구조의 어긋남을 매 빌드마다 잡는다(어긋나면 CI가 빨개진다 —
 *     "남겨 둔다"로 끝내지 않는다).
 */
export const RESERVED_FIRST_SEGMENTS = new Set([
  // ① 파생 — 레거시 리소스명. 순수 데이터 import라 항상 최신(위 주석 참조).
  ...Object.keys(MIGRATED_RESOURCES),
  ...Object.keys(RENAMED_RESOURCES),
  ...Object.keys(RETIRED_RESOURCES),
  // ② 손 스냅샷(의도적, 2026-08-01 재실측) — 라이브 top-level 페이지 라우트(`app/*`+
  // `app/(authenticated)/*`, `[ws]`/`(authenticated)` 제외) + Next.js 메타데이터 파일
  // 라우트. `scripts/verify-reserved-first-segments-sync.ts`가 어긋남을 CI에서 잡는다.
  'activity', 'api', 'apple-icon.png', 'auth', 'channel', 'chats', 'dashboard',
  'favicon.ico', 'forgot-password', 'gates', 'icon.svg', 'inbox', 'internal-dogfood',
  'invite', 'login', 'manifest.webmanifest', 'meetings', 'mfa', 'more', 'onboarding',
  'org-briefing', 'organization', 'privacy', 'register', 'reset-password', 'rewards',
  'settings', 'share', 'terms', 'verify-email',
]);

/**
 * story #2039 AC3 — 예전엔 여기서 kebab·ASCII 형식(SLUG_FORMAT)까지 검사해 형식이 안 맞으면
 * resolve fetch 자체를 생략했다. 그런데 **구 한글 slug(예: `장사왕`)가 정확히 그 형식에서
 * 탈락**한다 — resolve의 목적이 "이 세그먼트가 구 slug일 수 있으니 canonical로 안내"인데,
 * 형식 검사가 그 대상을 fetch 이전에 걸러버려 정작 필요한 자리에서 무력했다(원 결함 —
 * "주소는 영문일 것"이라는 가정 — 이 호환 경로에 그대로 남아있던 것). RESERVED_FIRST_SEGMENTS
 * 회피 목적(flat 라우트 오인 방지)만 남기고 형식 검사는 제거한다 — 형식이 이상해도 resolve가
 * 최종 판정한다(not_found면 그대로 통과, Next 자체 404로 정직하게 실패).
 */
export function looksLikeWorkspaceSegment(segment: string | undefined | null): segment is string {
  if (!segment) return false;
  return !RESERVED_FIRST_SEGMENTS.has(segment);
}

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
): Promise<{ orgSlug: string; projectSlug: string } | null> {
  try {
    const authHeader = { Authorization: `Bearer ${accessToken}` };
    // ⛔카디르 QA 근본 재진단(2026-08-09, 실측 8회 재현) — 이 함수의 project 조회(단건·리스트
    // 둘 다)가 X-Org-Id 없이 나가면 BE get_verified_org_id가 **JWT 기본 org**로 스코프한다.
    // 세션의 현재/타겟 org(이 함수의 orgId 파라미터)가 JWT 기본 org와 다른 멀티org 계정에선
    // 엉뚱한 org로 스코프돼 빈 결과/404가 난다(curl로 X-Org-Id 붙이면 정상 확認됨) — 위
    // 리스트 폴백 fix가 이 헤더 없이는 애초에 못 먹었던 진짜 근본원인.
    const authHeaderWithOrg = { ...authHeader, 'X-Org-Id': orgId };
    const [orgRes, projRes] = await Promise.all([
      fetch(`${fastapiUrl}/api/v2/organizations/${orgId}`, { headers: authHeader }),
      fetch(`${fastapiUrl}/api/v2/projects/${projectId}`, { headers: authHeaderWithOrg }),
    ]);
    if (!orgRes.ok) return null;
    const org = await orgRes.json() as { slug?: string };
    if (!org.slug) return null;

    let projectSlug = projRes.ok ? ((await projRes.json() as { slug?: string | null }).slug ?? null) : null;
    // ⛔실측 결함(2026-08-09, PO puppeteer 재현 — 흐름 메뉴→/flow bare→dead-end 404) — 단건조회
    // (GET /projects/{id})가 정상 프로젝트(slug 有)인데도 이따금 slug 없이/실패 응답해 이 자리가
    // dead-end 404였다(근본원인=위 X-Org-Id 누락). 리스트 엔드포인트(GET /projects)는 같은
    // 프로젝트를 직접 대조로 항상 정확히 낸다는 걸 확認했다 — 단건조회가 비면 그 자리에서
    // 정직하게 포기하지 않고 리스트에서 안전하게 한 번 더 찾는다.
    if (!projectSlug) {
      const listRes = await fetch(`${fastapiUrl}/api/v2/projects`, { headers: authHeaderWithOrg });
      if (listRes.ok) {
        const list = await listRes.json() as Array<{ id?: string; slug?: string | null }>;
        projectSlug = list.find((p) => p.id === projectId)?.slug ?? null;
      }
    }
    if (!projectSlug) return null;
    return { orgSlug: org.slug, projectSlug };
  } catch {
    return null;
  }
}
