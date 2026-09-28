/**
 * story #4160(#4037 후속·클래스 봉쇄) — `page.waitForLoadState('networkidle')`/
 * `{ waitUntil: 'networkidle' }`는 이 앱의 (authenticated) 셸이 SSE를 계속 붙잡아
 * "네트워크가 조용해지는 순간"이 영영 안 올 수 있는 flake 클래스(story #4037 PR #4417이
 * 6파일 7곳, 이 카드가 9번째 파일 content-post-manager-states.spec.ts 8곳을 닫음).
 * 이 가드는 `apps/web/e2e/**\/*.spec.ts`(+ 공용 헬퍼) 전체에서 그 클래스가 다시 새지
 * 않게 고정한다.
 *
 * count-pin 관례(verify-nav-v3-single-source.ts와 동형) — 파일별 "허용 개수"를 정확히
 * 고정한다. 늘면 FAIL, 줄면 통과(고쳤다면 좋은 일 — 다음에 손댄 사람이 숫자를 낮춰
 * 갱신한다).
 *
 * 예외는 ALLOWED_EXCEPTIONS 하나뿐(contrast-guard.spec.ts) — story #3842가 세운 고의
 * 설계: `/onboarding`은 `(authenticated)` 밖(DashboardShell 없음·SSE 연결 없음)이라
 * networkidle이 실제로 선다. reason 없는 항목은 무효(빈 문자열 거부) — "왜"가 주석이
 * 아니라 이 가드 자신의 계약이어야 다음 사람이 안 놓친다.
 *
 * ⭐PO 지시(2026-09-22) — exception이 "정말 셸 밖 경로 전용인가"는 코드 주석이 아니라
 * 구조로 검증한다. contrast-guard.spec.ts는 PAGES 데이터 표에 `wait: { kind: 'networkidle' }`
 * 를 쓰는 항목이 있는 페이지만 그 API를 부른다(waitForPageMarker가 marker.kind로 분기) —
 * 그 표 안에서 `kind: 'networkidle'`을 쓰는 모든 항목의 `path`가 '/onboarding'으로
 * 시작하는지를 별도로 검증한다(verifyContrastGuardOnboardingOnly). 이걸 지우거나(음성
 * 대조 ①) 다른 경로에 kind:'networkidle'을 하나 더 얹으면(음성 대조 ②) RED.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../e2e');

// waitForLoadState('networkidle', ...) / { waitUntil: 'networkidle' } 둘 다 잡는다.
// 주석 스트립 후 스캔(다른 verify-*.ts와 동형 관례) — 설명용 언급은 대상 밖.
const NETWORKIDLE_CALL_RE = /waitForLoadState\(\s*['"`]networkidle['"`]|waitUntil:\s*['"`]networkidle['"`]/g;

export interface NetworkidleException {
  file: string; // e2e/ 기준 상대경로
  reason: string;
  count: number;
  /** 구조적 "왜" 검증 — 주석이 아니라 코드 형태로 재확인. 생략하면 count-pin만 적용. */
  verify?: (content: string) => { ok: boolean; detail?: string };
}

/** contrast-guard.spec.ts PAGES 표에서 kind:'networkidle'을 쓰는 모든 항목의 path가
 * '/onboarding'으로 시작하는지 확인한다(그 표는 한 줄 = 한 페이지 항목 관례). */
function verifyContrastGuardOnboardingOnly(content: string): { ok: boolean; detail?: string } {
  // 타입 선언부(`type PageWaitMarker = ... { kind: 'networkidle' } ...`)는 데이터 항목이
  // 아니라 판별 유니온 정의라 path가 없다 — PAGES 배열 선언 이후만 스캔한다.
  const pagesStart = content.indexOf('const PAGES');
  const scanRegion = pagesStart >= 0 ? content.slice(pagesStart) : content;
  const lineOffset = pagesStart >= 0 ? content.slice(0, pagesStart).split('\n').length - 1 : 0;

  const offendingLines: number[] = [];
  scanRegion.split('\n').forEach((line, i) => {
    if (/kind:\s*['"`]networkidle['"`]/.test(line) && !/path:\s*['"`]\/onboarding/.test(line)) {
      offendingLines.push(lineOffset + i + 1);
    }
  });
  if (offendingLines.length > 0) {
    return {
      ok: false,
      detail: `kind:'networkidle' 항목이 /onboarding* 외 경로에도 쓰임(라인 ${offendingLines.join(', ')})`,
    };
  }
  return { ok: true };
}

export const ALLOWED_EXCEPTIONS: NetworkidleException[] = [
  {
    file: 'contrast-guard.spec.ts',
    reason:
      'story #3842 고의 설계 — /onboarding은 (authenticated) 밖(DashboardShell 없음·SSE 연결 없음)이라 networkidle이 실제로 선다. 다른 모든 페이지는 response-marker(ACTIVATION_CHECKLIST_MARKER).',
    count: 1,
    verify: verifyContrastGuardOnboardingOnly,
  },
];

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countNetworkidle(content: string): number {
  return (stripComments(content).match(NETWORKIDLE_CALL_RE) ?? []).length;
}

function walkSpecFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkSpecFiles(full));
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

export interface Violation {
  file: string;
  kind: 'unexpected' | 'count-exceeded' | 'count-under' | 'exception-invalid' | 'exception-unverified';
  detail: string;
}

export function scanE2eForNetworkidle(e2eRoot = E2E_ROOT, exceptions = ALLOWED_EXCEPTIONS): Violation[] {
  const violations: Violation[] = [];
  const allowedByFile = new Map(exceptions.map((e) => [e.file, e]));

  // 선언된 예외 자체의 무결성 — reason 빈 문자열은 무효(주석이 아니라 계약).
  for (const exc of exceptions) {
    if (!exc.reason.trim()) {
      violations.push({ file: exc.file, kind: 'exception-invalid', detail: 'reason이 비어 있다 — 이유 없는 예외는 무효' });
    }
  }

  for (const abs of walkSpecFiles(e2eRoot)) {
    const rel = path.relative(e2eRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf-8');
    const actual = countNetworkidle(content);
    const allowed = allowedByFile.get(rel);

    if (!allowed) {
      if (actual > 0) {
        violations.push({ file: rel, kind: 'unexpected', detail: `${actual}건(허용 0, 미등재 파일)` });
      }
      continue;
    }

    if (actual > allowed.count) {
      violations.push({ file: rel, kind: 'count-exceeded', detail: `${actual}건(선언 ${allowed.count}건 초과)` });
    } else if (actual < allowed.count) {
      violations.push({ file: rel, kind: 'count-under', detail: `${actual}건(선언 ${allowed.count}건 미달 — count-pin 하향 갱신 필요)` });
    }

    if (allowed.verify) {
      const result = allowed.verify(content);
      if (!result.ok) {
        violations.push({ file: rel, kind: 'exception-unverified', detail: result.detail ?? '구조 검증 실패' });
      }
    }
  }

  return violations;
}

function main(): number {
  const violations = scanE2eForNetworkidle();
  if (violations.length === 0) {
    console.log('OK: apps/web/e2e 전체 networkidle 0(예외 1건 count-pin·구조 검증 통과, story #4160).');
    return 0;
  }
  console.error('FAIL: e2e networkidle 회귀가드(story #4160):');
  for (const v of violations) console.error(`  - ${v.file} [${v.kind}]: ${v.detail}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
