/**
 * story #2393 — `proxy.ts`(edge 미들웨어)와 `route-resolve.ts`가 «둘 다» 참조해야 하는
 * 레거시 리소스 이름 표를 여기 하나로 뺐다. proxy.ts가 route-resolve.ts를 import하므로(fetchResolve
 * 등), route-resolve.ts가 반대로 proxy.ts를 import하면 순환참조가 된다 — 이 파일은 어느 쪽도
 * import하지 않는 순수 데이터 leaf 모듈이라 그 순환을 피한다. proxy.ts는 여기서 import해 그대로
 * re-export한다(기존 소비처 `scripts/verify-no-orphan-resource-routes.ts`가 `../src/proxy`에서
 * 이 표들을 가져오던 경로를 그대로 유지 — story #2387 참고).
 */

/**
 * story a539c649 S-route-project — 이관 완료된 Project-tier 리소스 목록(flat 첫 세그먼트 →
 * 그 리소스 밑에서 project-scope 아닌 채로 존치되는 서브패스 제외 목록). 슬라이스가 리소스를
 * `/{ws}/{proj}/{resource}`로 옮길 때마다 여기 키 하나씩 추가한다(S2=docs, S3a=standup 등).
 */
export const MIGRATED_RESOURCES: Record<string, string[]> = {
  docs: ['design-tokens'], // 비-project 정적 페이지, 존치
  standup: [],
  retro: [],
  loops: [],
  artifacts: [],
  mockups: [],
  sprints: [],
  storage: [],
  epics: [],
  board: [],
  // story #2224(선생님 정정 2026-07-30) — glance는 원래 ws/proj-scoped로 "이관"된 적이 없는
  // 순수 top-level 라우트였지만, "보드+현황판 통합"의 실제 자리가 /flow로 확定되며 같은 부류의
  // 문제(bare 딥링크가 org+project를 몰라 해소해야 함)가 생겼다 — 이미 검증된 이 표를 재사용
  // 한다(새 미들웨어 층을 세우지 않는다, proxy.ts의 redirectRenamedResourcePath와 짝).
  glance: [],
  // ⛔실측 발견(2026-07-30, 진입점 전수 스윕 중) — `flow` 자체가 이 표에 «없었다». 사이드바
  // (app-sidebar.tsx)는 항상 `resourceLink('flow')`로 실 slug를 채운 경로만 썼기에 이 갭이
  // 안 보였는데, mobile-tab-bar.tsx의 "지금" 탭 href를 bare `/flow`로 바꾸며(옛 `/glance`
  // 대체) 처음으로 실사용 경로가 생겼다 — 등록 없이 나갔으면 즉시 404였을 것.
  flow: [],
  // story #2016: 8fc51517(B1 리네이밍)이 epics→goals 경로 리터럴을 바꾸면서 RENAMED_RESOURCES에만
  // 반영되고 여기(MIGRATED_RESOURCES)엔 신 이름 'goals'를 안 넣었다 — bare `/epics`는 이 표를 거쳐
  // `/{ws}/{proj}/epics`로 301된 뒤 redirectRenamedResourcePath가 2차로 `goals`로 다시 301하지만,
  // bare `/goals`(신 이름 그대로 오는 딥링크·북마크·검색결과)는 애초에 이 표에 키가 없어 redirectLegacyResourcePath가
  // 즉시 null 반환 → Next 자체 404. 호스트/쿠키 무관 리소스 등록 누락 실측 확認(direct Cloud Run 호스트에서
  // /board는 301 정상·/goals만 404, 동일 JWT fallback 경로 재사용).
  goals: [],
};

/**
 * story 8fc51517(계층 리네이밍 B1, doc hierarchy-renaming-url-implementation-design §ⓑ) —
 * `/{ws}/{proj}/{resource}` 안의 **경로 리터럴**이 신 용어로 바뀔 때(에픽→목표 등)의 301.
 * proxy.ts의 `redirectLegacyResourcePath`와 다른 관심사 — 저건 ws/proj 세그먼트 자체가 없던
 * 옛 flat URL을 org/project 재조회로 채워 넣는 것이고, 이건 ws/proj가 **이미 URL에 있으므로**
 * 3번째 세그먼트(리소스명)만 신 이름으로 교체하면 된다(org/project 재조회 fetch 불요).
 *
 * story #2387(2026-08-01) — `scripts/verify-no-orphan-resource-routes.ts`가 이 표(+
 * RETIRED_RESOURCES)에서 RENAMED_RESOURCE_ALIASES를 파생시킨다(예전엔 손으로 옮겨 적은
 * 스냅샷이었다 — story #2378 리뷰에서 유나양이 발견). story #2393(2026-08-01) — route-resolve.ts의
 * RESERVED_FIRST_SEGMENTS도 여기서 파생시킨다(순환참조 회피를 위해 이 표 자체를 proxy.ts
 * 밖으로 뺀 것이 그 이유).
 */
export const RENAMED_RESOURCES: Record<string, string> = {
  epics: 'goals',
  // story #2224(선생님 정정 2026-07-30) — glance는 이제 /flow 안의 한 조각. 위 MIGRATED_RESOURCES
  // 항목과 짝: bare `/glance` → (redirectLegacyResourcePath) → `/{ws}/{proj}/glance` →
  // (여기) → `/{ws}/{proj}/flow`. `?story=`/`?task_id=` 등 쿼리는 두 함수 다 request.nextUrl을
  // clone해 그대로 들고 가므로 안전(RESOLVE_RETRY_PARAM 외엔 손대지 않는다).
  glance: 'flow',
  // #2227 AC8(2026-07-27) 종료 조건 — board 제거는 flow 리다이렉트 포함이 조건이었다(유나
  // 2026-08-01 지적: prod 승격 #2373에서 board 라우트만 지우고 이 줄을 빠뜨려 외부 딥링크
  // ~14곳이 404를 만날 뻔했다 — board/page.tsx:12-13 자체가 이 위험을 이미 적어 두고 있었다).
  board: 'flow',
};

/**
 * story #2378(2026-08-01, 유나양 design:changes) — `RENAMED_RESOURCES`와 «성격이 다른» 은퇴.
 * 위 표(epics/glance/board)는 같은 행이 새 이름을 받은 rename이라 id를 그대로 들고 가도 안전
 * (mockups 3번째 세그먼트 뒤 id가 있으면 「그 id」로 다시 찾을 수 있다). 여기는 반대 —
 * `RETIRED_RESOURCES`에 오르면 옛 리소스가 «폐기»되고 다른 리소스가 그 자리를 대신할 뿐이라
 * id 공간이 다르다(mockup id ≠ artifact id). id를 그대로 옮기면 두 가지 결과가 갈리는데
 * ①못 찾음(404)보다 ⭐②우연히 같은 id의 «남의 항목»이 열리는 쪽이 더 무겁다 — 사용자가
 * 잘못된 항목을 보고 있다는 것을 알 방법이 없다. 그래서 proxy.ts의 `redirectRetiredResourcePath`
 * 는 id를 버리고 목록 루트로만 보낸다.
 *
 * `mockups: 'artifacts'` — dev DB 실측(2026-08-01, PO)으로 `mockups` 테이블 자체가 없고
 * mockup_scenarios/versions/pages 전부 0건이라 dev 기준으로는 되살아날 id 자체가 없다(⚠️
 * prod는 안 쟀다 — 오늘 이 저장소에서 `board:'flow'`가 main에만 있고 develop엔 없었던 사례처럼
 * 환경별로 실측이 갈릴 수 있다. id를 버리는 처리 자체는 그 실측과 무관하게 안전하다). E-CANVAS가
 * `mockups`의 부분 후계라(스토리 본문 — 시나리오 분기·자유배치 편집·버전 복원·9종 팔레트·
 * category/slug는 안 옮겨짐, 필요 시 별건) 목록 화면(`/artifacts`)이 최소 충족선이다.
 */
export const RETIRED_RESOURCES: Record<string, string> = {
  mockups: 'artifacts',
};
