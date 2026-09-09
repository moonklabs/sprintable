/**
 * story #3739(2026-09-09, PO 決) 메타 가드 — 「만들어졌는데 도는 자리 없음」 클래스(story
 * #3736 ⑪이 `verify:no-handrolled-card`에서, 이 스토리 자신이 `verify:no-direct-backend-
 * v2-call`·`verify:no-new-raw-button`에서 각각 발견) 재발을 막는다. `package.json`의
 * `verify:*` 스크립트 집합이 `ci.yml`이 실제로 부르는 `pnpm --filter web verify:*` 집합의
 * 부분집합이 아니면(등재됐는데 안 부르는 이름이 있으면) FAIL — 「규칙+가드+baseline까지
 * 다 있는데 돌리는 자만 없다」를 CI 자신이 스스로 재도록 한다.
 *
 * 의도적 제외(예: 로컬 전용 유틸리티, 배포 프리뷰 전용 스크립트 등)는 삭제하지 않고
 * ALLOWLIST에 사유와 함께 등재한다(count-pin — 늘어나면 FAIL, 줄면 통과. story #3164류
 * baseline-freeze와 동형 규율).
 *
 * 페드루 PO 리뷰(2026-09-09 10:23Z, #4084 머지 前) — 이 count-pin 약속을 "늘어나면
 * FAIL"이라 적어 놓고 실제로 그 크기를 재는 자가 main()에도 테스트에도 없었다(재는
 * 자 없이 규칙만 있는 것 — 이 가드 자신이 닫으려던 바로 그 클래스가 이 가드 자신의
 * 탈출구에 남아 있던 자리). `ALLOWLIST_MAX`(아래)로 상한을 명시하고 main()이 그 값을
 * 실제로 재서 FAIL한다.
 *
 * ⚠️이 가드가 «못 잡는» 것:
 *   ㉠ ci.yml이 `pnpm --filter web verify:X`가 아닌 다른 형태(예: `pnpm run verify:X`,
 *      셸 변수로 조립된 이름)로 부르면 놓친다 — 지금 저장소의 모든 verify:* 스텝이
 *      정확히 `pnpm --filter web verify:<name>` 리터럴 형이라(이 스캔이 확인) 지금은
 *      문제 없지만, 새 스텝을 다른 형태로 적으면 이 가드가 오탐 FAIL을 낸다.
 *   ㉡ ci.yml에 물려 있어도 그 스텝이 실제로 실행되는지(조건부 `if:`로 항상 skip되는
 *      스텝 등)는 안 본다 — 문자열 등장 여부만 본다.
 *   ㉢ ci.yml 밖의 다른 워크플로 파일(.github/workflows/*.yml 나머지)은 안 본다 —
 *      ci.yml 단일 파일만 스캔 대상(지금 저장소의 verify:* 스텝은 전부 이 파일에 있다).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 의도적 제외 — 삭제하지 않고 사유를 남긴다. 지금은 빈 목록(전건 배선 완료, story #3739).
export const ALLOWLIST: Record<string, string> = {};

// count-pin 상한 — 지금 값(0)보다 늘어나면 FAIL(항목을 지우지 않고 몰래 쌓는 것을 막는다).
// 정말 새 제외가 필요하면 이 값도 함께 올리고 PR 본문에 사유를 적을 것(PO 승인).
export const ALLOWLIST_MAX = 0;

const PACKAGE_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const CI_YML_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/ci.yml');

// self-assert — 재료가 비정상적으로 적으면(파싱 경로가 헛돈 것) 조용한 통과 대신 죽는다
// (story #3164/#2710류 관례).
const MIN_EXPECTED_SCRIPTS = 20;

export function loadVerifyScriptNames(packageJsonPath: string): Set<string> {
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  const names = new Set<string>();
  for (const key of Object.keys(parsed.scripts ?? {})) {
    if (key.startsWith('verify:')) names.add(key);
  }
  return names;
}

const CI_INVOCATION_RE = /pnpm --filter web (verify:[a-z0-9-]+)/g;

export function loadCiWiredScriptNames(ciYmlContent: string): Set<string> {
  const names = new Set<string>();
  for (const m of ciYmlContent.matchAll(CI_INVOCATION_RE)) {
    names.add(m[1]);
  }
  return names;
}

export function computeUnwired(scripts: Set<string>, wired: Set<string>, allowlist: Record<string, string>): string[] {
  return [...scripts].filter((s) => !wired.has(s) && !(s in allowlist)).sort();
}

// main()과 테스트가 같은 심볼을 부른다(페드루 PO 리뷰 관례, story #3164 PR#3580) —
// count-pin 판정 로직이 main() 안에만 있으면 테스트가 그 코드를 재실행할 수 없다.
export function isAllowlistOverLimit(allowlist: Record<string, string>, max: number): boolean {
  return Object.keys(allowlist).length > max;
}

function main(): number {
  const scripts = loadVerifyScriptNames(PACKAGE_JSON_PATH);
  if (scripts.size < MIN_EXPECTED_SCRIPTS) {
    console.error(
      `FAIL: package.json에서 verify:* 스크립트가 ${scripts.size}개뿐 발견됨(경로=${PACKAGE_JSON_PATH}) — ` +
        `이 가드가 헛돌고 있다.`,
    );
    return 1;
  }

  let ciContent: string;
  try {
    ciContent = readFileSync(CI_YML_PATH, 'utf8');
  } catch {
    console.error(`FAIL: ci.yml을 못 읽음(경로=${CI_YML_PATH}) — 이 가드가 헛돌고 있다.`);
    return 1;
  }
  const wired = loadCiWiredScriptNames(ciContent);
  if (wired.size < MIN_EXPECTED_SCRIPTS) {
    console.error(`FAIL: ci.yml에서 wired verify:* 호출이 ${wired.size}개뿐 발견됨 — 이 가드가 헛돌고 있다.`);
    return 1;
  }

  const unwired = computeUnwired(scripts, wired, ALLOWLIST);

  console.log(
    `[story #3739 메타 가드] package.json verify:* ${scripts.size}개 · ci.yml 배선 ${wired.size}개 · ` +
      `ALLOWLIST ${Object.keys(ALLOWLIST).length}개(상한 ${ALLOWLIST_MAX}개)`,
  );

  if (isAllowlistOverLimit(ALLOWLIST, ALLOWLIST_MAX)) {
    console.error(
      `\nFAIL: ALLOWLIST가 ${Object.keys(ALLOWLIST).length}개로 상한(${ALLOWLIST_MAX}개)을 넘었다 — ` +
        'count-pin 위반(「늘어나면 FAIL」 약속). 정말 의도적 제외가 늘어난 것이라면 ' +
        'ALLOWLIST_MAX도 같이 올리고 PR 본문에 사유를 적을 것(PO 승인).',
    );
    return 1;
  }

  if (unwired.length > 0) {
    console.error('\nFAIL: package.json에 등재된 verify:* 중 ci.yml에 안 물린 것 발견(「만들어졌는데 도는 자리 없음」 클래스):');
    for (const name of unwired) {
      console.error(`  - ${name}`);
    }
    console.error(
      '\n→ ci.yml에 `pnpm --filter web ' +
        (unwired[0] ?? '<name>') +
        '` 스텝을 추가하거나, 정말 의도적 제외라면 이 스크립트(verify-ci-wires-all-verify-scripts.ts)의 ' +
        'ALLOWLIST에 사유와 함께 등재할 것(PO 승인).',
    );
    return 1;
  }

  console.log('\nOK: package.json의 모든 verify:* 스크립트가 ci.yml에 배선돼 있다.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
