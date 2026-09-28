/**
 * story #4211(PO 4차) — `/{첫 조각}`이 워크스페이스 slug가 될 수 없는 예약 목록과 판정 함수. `route-resolve.ts`(proxy 전용 ·
 * jose 의존)에서 이 순수 데이터 모듈로 옮겼다 — 클라이언트 탭바·사이드바 scope 계산(nav-v3-destinations)도 같은 목록을 쓰되
 * 서버 전용 의존을 클라이언트 번들로 끌고 오지 않게. `route-resolve.ts`는 그대로 re-export(기존 import·CI 동기 가드 무변).
 */
import { MIGRATED_RESOURCES, RENAMED_RESOURCES, RETIRED_RESOURCES } from './legacy-resource-tables';

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
  '.well-known', 'activity', 'api', 'apple-app-site-association', 'apple-icon.png', 'auth',
  'campaigns', 'channel',
  // [SID:3972] 슬라이스②AC2 — 새 최상위 app/chat/page.tsx(시안 ② 3단 허브, 기능
  // 플래그 뒤) 신설. 미등재 시 '/chat'이 워크스페이스 slug로 오인될 수 있다
  // ('today'(#3807 desktop류) 선례와 동형 등재).
  'chat', 'chats',
  // story #3982(2026-09-17) — 새 최상위 app/connect-rules(「연결·규칙」 v3 화면,
  // (authenticated) 밖 별도 라우트 그룹, 「오늘」#3962 선례 동형) 신설. 미등재 시
  // '/connect-rules'가 워크스페이스 slug로 오인될 수 있다(위 #3807 desktop과 동형 결함
  // 클래스).
  'connect-rules',
  'content', 'dashboard',
  // [SID:3807] 슬라이스12 AC2 — 새 최상위 app/desktop/updates/macos.json(공개 업데이트
  // 매니페스트 중계) 신설. 미등재 시 '/desktop/...'가 워크스페이스 slug로 오인될 수 있다
  // (카디르 QA #4187 발견) — 이 카드의 AC3(다운로드 화면, /desktop) 자리도 같은 등재.
  'desktop',
  'favicon.ico', 'forgot-password', 'gates', 'icon.svg', 'inbox', 'internal-dogfood',
  'invite', 'login', 'loop-queue', 'manifest.webmanifest', 'meetings', 'mfa', 'more',
  // [P1] iOS TestFlight 구글 로그인 후 404 인시던트 — AASA(.well-known/apple-app-site-association)
  // + native/oauth-return 신설(verify-reserved-first-segments-sync.test.ts가 이 목록 누락을
  // 실측으로 잡았다).
  'native', 'onboarding',
  'org-briefing', 'organization', 'privacy', 'refund-policy', 'register', 'reset-password',
  'rewards', 'set-password', 'settings', 'share', 'terms',
  // story #3962(2026-09-17) — 새 최상위 app/today(v3 첫 화면, (authenticated) 밖
  // 별도 라우트 그룹) 신설. 미등재 시 '/today'가 워크스페이스 slug로 오인될 수 있다
  // (위 #3807 desktop 선례와 동형 결함 클래스).
  'today',
  'unsubscribe', 'verify-email',
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
