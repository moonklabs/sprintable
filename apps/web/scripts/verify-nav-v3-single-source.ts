/**
 * story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:31Z) — "v3 플래그 결정을 여러
 * 곳에서 각자 내린다"는 4016·4017 스택이 원래 없애려던 결함 그 자체가 이 스택 **안**에서
 * 재발했다: session-redirect.ts가 chatV3Enabled 불리언 하나로 '/chat'·'/chats' 리터럴을
 * 자체 조립했고, api/auth/callback 라우트도 같은 리터럴을 또 조립했고, proxy.ts·
 * app/page.tsx·organization/connectors/page.tsx가 TODAY_V3_ENABLED 등 env 이름을 각자
 * 다시 읽었다(11곳). 이 가드는 그 두 축을 코드 리뷰 없이도 고정한다:
 *   ① TODAY_V3_ENABLED·CHAT_V3_ENABLED·CONNECT_RULES_V3_ENABLED 세 env 이름은
 *      nav-v3-flags-server.ts(readNavV3FlagsFromEnv) 한 곳에서만 process.env로 읽는다.
 *   ② '/today'·'/org-briefing'·'/chats'·'/chat'·'/connect-rules' 다섯 목적지 문자열
 *      리터럴은 nav-v3-destinations.ts(resolveNavV3Destinations 및 그 서술자 값) 한
 *      곳에서만 나온다.
 * 두 축 다 *.test.* 파일은 항상 허용(기대값 assert가 본업이라 리터럴이 있어야 정상) —
 * 아래 ALLOWED_NON_TEST_FILES만 비-테스트 예외(전부 그라운딩 근거 첨부, PO 확認 대상).
 *
 * ⚠️이 가드가 «못 잡는» 것: 문자열이 `//`·`/* *‌/` 주석 밖 실 코드에 있는지만 구분한다
 * (라인/블록 주석 스트립 후 스캔) — 동적으로 조립된 문자열(`'/ch' + 'ats'`류)은 못 잡는다
 * (이 코드베이스 관례상 그런 조립은 없음, verify-no-hand-rolled-marketing-table.ts류와
 * 동일 한계 declared).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

export const ENV_NAMES = ['TODAY_V3_ENABLED', 'CHAT_V3_ENABLED', 'CONNECT_RULES_V3_ENABLED'] as const;
export const DEST_LITERALS = ['/today', '/org-briefing', '/chats', '/chat', '/connect-rules'] as const;

const ENV_HOME_FILE = 'src/lib/nav-v3-flags-server.ts';
const DEST_HOME_FILE = 'src/lib/nav-v3-destinations.ts';

// story #4017 그라운딩(AC1 표) + 이 가드 작성 시점 실 스캔이 확定한 비-테스트 예외 —
// 전부 "이 파일은 애초에 이 목적지 모듈이 결정할 대상이 아니다"는 근거가 있다(PO 확認).
export const DEST_ALLOWED_NON_TEST_FILES: Record<string, string> = {
  'src/app/(authenticated)/chats/[conversation_id]/page.tsx': '/chats 캐노니컬 라우트 자기참조(pagination·history 복귀) — 그 라우트 자신이라 목적지 "결정"이 아님.',
  'src/app/(authenticated)/chats/layout.tsx': '위와 동형 — /chats 자기 경로 판정(isListRoute).',
  'src/app/dashboard/dashboard-shell.tsx': 'TAB_ROOT_PREFIXES — 태블릿 레이아웃 CSS 적용 판정 배열(다른 축), nav 목적지 결정이 아님.',
  'src/app/invite/accept/invite-accept-client.tsx': '로그인 전 화면(DashboardContext 밖) — 플래그를 받을 방법이 아직 없음(#4017 AC 스코프 밖, PO 그라운딩 DM 참고).',
  'src/app/invite/accept/page.tsx': '위와 동형(로그인 전).',
  'src/app/invite/page.tsx': '위와 동형(로그인 전).',
  'src/app/mfa/page.tsx': '위와 동형(로그인 전).',
  'src/app/onboarding/onboarding-form.tsx': '위와 동형(로그인 전).',
  'src/components/chat/chat-view.tsx': 'backHref 기본 prop 값(호출부가 얼마든지 override) — 컴포넌트 API 기본값이지 하드코딩 내비게이션이 아님.',
  'src/components/support-widget/support-widget-launcher.tsx': '현재 pathname을 읽어 UI 분기(isMobileChatDetailRoute)할 뿐 — 목적지를 "결정"하지 않음.',
  'src/lib/nav-config.ts': 'NAV_GROUPS/CHAT_CENTER_ITEM의 레거시 baseline 값 — resolveNavGroups/resolveChatCenterItem(같은 파일)이 이 baseline 위에 플래그를 얹는다(목적지 모듈이 소비하는 원본, 목적지 모듈 자신이 아닐 뿐).',
};

export const ENV_ALLOWED_NON_TEST_FILES: Record<string, string> = {};

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function isTestFile(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel);
}

export interface ScanResult {
  envViolations: Array<{ file: string; names: string[] }>;
  destViolations: Array<{ file: string; literals: string[] }>;
}

export function scan(repoRootAbs: string, webRootRel = 'apps/web'): ScanResult {
  const srcRoot = path.join(repoRootAbs, webRootRel, 'src');
  const envViolations: ScanResult['envViolations'] = [];
  const destViolations: ScanResult['destViolations'] = [];

  for (const abs of walkFiles(srcRoot)) {
    // src/ 안 파일만 walkFiles가 낸다 — apps/web 기준 상대경로라 항상 'src/'로 시작.
    const rel = path.relative(path.join(repoRootAbs, webRootRel), abs).split(path.sep).join('/');
    const code = stripComments(readFileSync(abs, 'utf-8'));

    if (rel === ENV_HOME_FILE || isTestFile(rel)) {
      // home file/tests always allowed for env names.
    } else {
      const foundEnvNames = ENV_NAMES.filter((n) => code.includes(n));
      if (foundEnvNames.length > 0 && !(rel in ENV_ALLOWED_NON_TEST_FILES)) {
        envViolations.push({ file: rel, names: foundEnvNames });
      }
    }

    if (rel === DEST_HOME_FILE || isTestFile(rel)) {
      // home file/tests always allowed for destination literals.
    } else {
      const foundLiterals = DEST_LITERALS.filter((lit) => new RegExp(`['"\`]${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(code));
      if (foundLiterals.length > 0 && !(rel in DEST_ALLOWED_NON_TEST_FILES)) {
        destViolations.push({ file: rel, literals: foundLiterals });
      }
    }
  }

  return { envViolations, destViolations };
}

function main(): number {
  const repoRootAbs = path.resolve(SRC_ROOT, '../../..');
  const { envViolations, destViolations } = scan(repoRootAbs);

  let failed = false;

  if (envViolations.length > 0) {
    failed = true;
    console.error(`FAIL: env 이름을 ${ENV_HOME_FILE} 밖에서 다시 읽는 자리(story #4017 CHANGES 2):`);
    for (const v of envViolations) console.error(`  - ${v.file}: ${v.names.join(', ')}`);
  }

  if (destViolations.length > 0) {
    failed = true;
    console.error(`FAIL: 목적지 문자열 리터럴을 ${DEST_HOME_FILE} 밖에서 다시 조립하는 자리(story #4017 CHANGES 2):`);
    for (const v of destViolations) console.error(`  - ${v.file}: ${v.literals.join(', ')}`);
  }

  if (failed) {
    console.error('\n→ readNavV3FlagsFromEnv()/resolveNavV3Destinations()를 그대로 재사용할 것 — 정말 예외면 이 스크립트의 ALLOWED 목록에 근거와 함께 등재(PO 승인).');
    return 1;
  }

  console.log('OK: env 이름·목적지 리터럴 둘 다 단일 소스 유지(story #4017 CHANGES 2).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
