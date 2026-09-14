// story #3826 후속(2026-09-14, 페드루 PO 지시) — PR#4259는 head가 PR#4258과 같은 sha라
// 게이트 슬롯 매처가 voided 행을 existing으로 재사용해 새 게이트가 안 생겼다(links 훅
// 200에도 sprintable/gate 0건). 이 줄(코드 무변, 주석만)이 head sha를 옮겨 새 게이트
// 슬롯을 트는 no-op 커밋이다.
/**
 * story #3826(UX-v3·FE 2, 페드루 PO 確定 2026-09-13) AC1 diff 가드 — 이 스토리의 diff는
 * `globals.css`의 원시 토큰(`--proof-*`) 값·`--proof-radius-soft` 값에만 있어야 한다.
 * 의미 토큰 alias(`--color-proof-*: var(--proof-*)` 매핑·Tailwind `@theme` 참조)·
 * `.dark` 블록·그 외 어떤 tsx/파일도 diff에 있으면 FAIL(카드 4계약값 ① AC1).
 *
 * ⛔핫픽스(2026-09-14, PR#4256/#4257 CI 차단·페드루 PO 確定): 이 가드가 ci.yml에
 * **모든 PR**에서 무조건 돌면서(스텝에 `if:` 없음) globals.css 외 파일이 changedFiles에
 * 있으면 그 PR이 토큰 교체 PR인지조차 안 묻고 FAIL했다 — 3826 자기 PR에서만 잰 계약값
 * (다른 PR에서 이 가드가 어떻게 판정하나는 안 잼)이 놓친 스코프. 처방은 조건 추가가
 * 아니라 **적용 범위 자체**: 이 가드는 「PR diff가 globals.css의 `--proof-*` 값 줄을
 * 바꿀 때」만 살아 있다.
 *  ⓪-a globals.css가 changedFiles에 없으면 OK(no-op — 이 가드가 볼 일이 아닌 PR).
 *  ⓪-b globals.css는 있어도 그 diff(주석 제외)에 `--proof-*` 값 줄 변경이 0건이면
 *      OK(globals.css를 다른 이유로 건드린 PR — 토큰 교체가 아니다).
 *  그 외(=globals.css에 `--proof-*` 값 줄 변경이 실제로 있음, "토큰 PR")에만 아래
 *  3축이 켜진다:
 *
 *  ① `git diff --name-only <base>...HEAD` = 정확히 `apps/web/src/app/globals.css` 1개
 *     (+ INFRA_ALLOWLIST).
 *  ② 그 diff의 변경 줄(주석 제외) 전부가 `--proof-*: <값>;` 형태(alias·다른 선언 0).
 *  ③ 변경된 줄 중 `.dark { ... }` 블록 라인 범위에 걸치는 것 0건(라이트 전용 교체
 *     — doc 3dc24888 §④, 다크는 이 PR에서 무변경).
 *
 * base ref는 `V3_TOKEN_DIFF_BASE`(기본 `origin/develop`) — 얕은 체크아웃(fetch-depth
 * 기본값)에서도 동작하도록 이 스크립트 자신이 필요하면 그 브랜치를 얕게 fetch한다
 * (CI의 공용 checkout 스텝의 fetch-depth를 이 스토리 때문에 fetch-depth: 0으로 넓히지
 * 않는다 — 그 변경은 전체 ci job에 영향을 주는 별개 결정이라 이 스토리 스코프 밖).
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGET_FILE = 'apps/web/src/app/globals.css';
const BASE_REF = process.env.V3_TOKEN_DIFF_BASE || 'origin/develop';

// 이 가드 자신을 들이는 PR(story #3826)은 필연적으로 이 스크립트 파일·package.json
// (신규 verify:* 등재)·ci.yml(신규 스텝 배선)도 같이 바꾼다 — 이건 "스타일 변경"이
// 아니라 가드 스캐폴딩 자체라 changed-files 검사에서 예외로 둔다(story #3739의
// verify-ci-wires-all-verify-scripts.ts ALLOWLIST 관례와 동형). 착지 뒤의 재발 방지
// 목적(원래 목적)에는 영향 없음 — 다음 PR부터는 이 파일들이 안 바뀌므로 changed-files가
// 정말 globals.css 1개만 남는다.
const INFRA_ALLOWLIST = new Set([
  'apps/web/scripts/verify-v3-token-diff-scope.ts',
  'apps/web/scripts/verify-v3-token-table-match.test.ts',
  'apps/web/package.json',
  '.github/workflows/ci.yml',
  // 아래 3개는 "tsx diff 0"의 정신(컴포넌트·렌더 로직 무변경)을 벗어나지 않는다 —
  // --proof-* 실측값을 그대로 하드코딩해 pin한 기존 회귀 테스트(story #2575/#2917류)
  // 라, 그 값이 바뀌는 원인(이 PR)과 결과(그 pin 갱신)가 분리 불가능한 같은 변경의
  // 두 절반이다. 로직 변경 0 — 숫자 리터럴 갱신 + 주석만(PR diff에서 직접 확인 가능).
  'apps/web/scripts/verify-tint-foreground-contrast.test.ts',
  'apps/web/scripts/verify-muted-foreground-contrast.test.ts',
  'apps/web/src/app/globals-scrollbar.test.ts',
  // 3826-pre(#4255) 후속 — 카디르 QA 지적으로 verify-no-new-alpha-text-foreground.ts의
  // 비교 로직을 순수 함수(compareToBaseline)로 뽑아내고 .test.ts 3표본을 추가(페드루 PO
  // 지시, 4254 rebase에 동봉). 토큰값 자체는 무변 — 이 가드의 코드 품질 보강일 뿐이라
  // "tsx diff 0" 정신(컴포넌트·렌더 로직 무변경) 밖이 아니다.
  'apps/web/scripts/verify-no-new-alpha-text-foreground.ts',
  'apps/web/scripts/verify-no-new-alpha-text-foreground.test.ts',
]);

// alias(--color-*)나 다른 선언이 아니라 --proof-* 원시 토큰 값 줄만 허용.
const RAW_TOKEN_LINE_RE = /^\s*--proof-[a-zA-Z0-9-]+:\s*.+;\s*$/;

// story #3826 주석은 여러 줄에 걸치고 각 줄이 `*`로 시작하지 않는 자유 서술형이라
// (예: "     story #3826..." — 들여쓰기만 있고 `*` 접두 없음) 줄 단위 정규식으로는
// "이 줄이 주석 안인지"를 못 가른다. `/* ... */` 블록을 통째로 제거한 뒤 diff하면
// 주석 전용 변경은 애초에 비교 대상에서 사라진다(줄 단위 휴리스틱보다 견고).
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function sh(cmd: string): string {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
}

function hasMergeBase(baseRef: string): boolean {
  try {
    sh(`git merge-base ${baseRef} HEAD`);
    return true;
  } catch {
    return false;
  }
}

// CI 첫 배선 시 실사고(2026-09-13, PR #4254): `git rev-parse --verify origin/develop`는
// 얕은 체크아웃에서도 그 ref 자체가 (얕게) 존재하면 성공해버려 fetch를 건너뛰는데,
// 그 얕은 ref가 HEAD와 공통 조상을 공유 못 할 만큼 얕으면(actions/checkout 기본
// fetch-depth=1) `git diff origin/develop...HEAD`가 "no merge base"로 죽는다 — ref
// 존재가 아니라 **merge-base 존재**를 확인해야 한다.
//
// 로컬 재현(2026-09-13, `git clone --depth 1`)으로 확인한 두 가지:
//  ① HEAD 자신도 얕으면(부모 커밋 자체가 없음) develop 쪽만 깊게 fetch해도 공통 조상을
//     못 찾는다 — depth를 develop 쪽만 늘리는 건 부질없다(HEAD가 얕은 게 진짜 원인).
//  ② `git fetch --unshallow <remote>`는 그 REPO를 만든 바로 그 remote로 해야 먹는다
//     (다른 remote는 shallow 협상 기준이 안 맞아 무반응) — 원 shallow 체크아웃의 remote
//     이름을 그대로 쓰면(실 CI에선 항상 origin) 전체 히스토리가 복구되고 merge-base가
//     바로 풀린다(로컬 실측 2.4s, 이 repo 크기 기준 CI 부담 허용 범위).
// 그래서: unshallow를 1차 시도(HEAD 쪽 얕음까지 함께 해결) → 그래도 안 되면(이미
// unshallow인데 ref 자체가 없는 경우 등) 명시 목적지로 fetch해 ref를 확실히 만든다.
function ensureBaseRefAvailable(baseRef: string): void {
  if (hasMergeBase(baseRef)) return;
  const [remote, branch] = baseRef.includes('/') ? baseRef.split(/\/(.+)/).slice(0, 2) : ['origin', baseRef];
  try {
    execSync(`git fetch --unshallow ${remote}`, { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    // 이미 unshallow(이 경우 정상 — shallow가 아니었다는 뜻)이거나 fetch 실패.
  }
  if (hasMergeBase(baseRef)) return;
  // unshallow가 안 먹혔거나(이미 unshallow인데 그 ref 자체가 로컬에 없던 경우) 여전히
  // 부족하면, 그 ref를 명시 목적지로 강제 생성/갱신(remote의 제한된 fetch refspec —
  // 얕은 단일-브랜치 체크아웃 — 때문에 이름만으로 fetch해도 추적 ref가 안 생길 수 있다).
  try {
    execSync(`git fetch --depth=1000 ${remote} ${branch}:refs/remotes/${remote}/${branch}`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  } catch {
    // 아래 최종 판정에서 걸러진다.
  }
  if (!hasMergeBase(baseRef)) {
    throw new Error(
      `FAIL: base ref(${baseRef})와 HEAD의 merge-base를 못 찾음(얕은 clone 한계) — CI checkout 설정 확인 필요.`,
    );
  }
}

export function parseChangedFiles(nameOnlyOutput: string): string[] {
  return nameOnlyOutput.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function parseChangedContentLines(unifiedDiff: string): string[] {
  const lines: string[] = [];
  for (const raw of unifiedDiff.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+') || raw.startsWith('-')) lines.push(raw.slice(1));
  }
  return lines;
}

export function findBraceBlockRange(cssContent: string, selectorLineRe: RegExp): [number, number] | null {
  const lines = cssContent.split('\n');
  const startIdx = lines.findIndex((l) => selectorLineRe.test(l));
  if (startIdx === -1) return null;
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^\s*}\s*$/.test(l));
  if (endIdx === -1) return null;
  return [startIdx + 1, endIdx + 1]; // 1-indexed 포함 범위.
}

export function parseHunkNewFileRanges(unifiedDiff: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = hunkRe.exec(unifiedDiff)) !== null) {
    const start = Number(m[1]);
    const count = m[2] !== undefined ? Number(m[2]) : 1;
    ranges.push([start, start + Math.max(count, 1) - 1]);
  }
  return ranges;
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

export type DiffScopeVerdict =
  | { kind: 'not_applicable'; reason: string }
  | { kind: 'out_of_scope'; reason: string }
  | { kind: 'in_scope' }
  | { kind: 'fail'; reason: string };

/** 순수 함수(changedFiles·globals.css의 --proof-* 값줄 변경 개수 → verdict) — 핫픽스
 * 본체. IO(git 호출) 0, main()이 이 함수 앞뒤로 실 git 데이터를 넣고 분기만 옮긴다. */
export function classifyDiffScope(
  changedFiles: string[],
  proofTokenLineChangeCount: number,
): DiffScopeVerdict {
  if (!changedFiles.includes(TARGET_FILE)) {
    return {
      kind: 'not_applicable',
      reason: `OK: ${TARGET_FILE}가 diff에 없음(no-op) — 이 가드는 그 파일의 --proof-* 값 줄을 바꾸는 PR에만 적용된다.`,
    };
  }
  if (proofTokenLineChangeCount === 0) {
    return {
      kind: 'out_of_scope',
      reason: `OK: ${TARGET_FILE} 변경은 있으나 --proof-* 값 줄 변경 0(토큰 교체 PR이 아니다) — 이 가드 대상 밖.`,
    };
  }
  const unexpected = changedFiles.filter((f) => f !== TARGET_FILE && !INFRA_ALLOWLIST.has(f));
  if (unexpected.length > 0) {
    return {
      kind: 'fail',
      reason: `FAIL: ${TARGET_FILE} 외 파일이 diff에 있다(AC1 위반): ${unexpected.join(', ')}`,
    };
  }
  return { kind: 'in_scope' };
}

export function countProofTokenLineChanges(contentLines: string[]): number {
  return contentLines.filter((l) => RAW_TOKEN_LINE_RE.test(l)).length;
}

function main(): number {
  ensureBaseRefAvailable(BASE_REF);

  const changedFiles = parseChangedFiles(sh(`git diff --name-only ${BASE_REF}...HEAD`));
  if (changedFiles.length === 0) {
    console.log(`OK: ${BASE_REF}...HEAD 사이 diff 0건(브랜치가 base와 같음 — 통과).`);
    return 0;
  }

  if (!changedFiles.includes(TARGET_FILE)) {
    const verdict = classifyDiffScope(changedFiles, 0);
    // changedFiles에 TARGET_FILE이 없으므로 항상 'not_applicable' — 명시 내로잉(위
    // union 중 이 분기만 `reason` 접근, tsc가 in_scope에는 reason이 없다고 정확히 잡는다).
    if (verdict.kind === 'not_applicable') console.log(verdict.reason);
    return 0;
  }

  // globals.css가 changedFiles에 있다 — 실 값(--proof-* 줄 변경 개수)을 재서 이 PR이
  // "토큰 PR"인지 먼저 가른다(핫픽스 ⓪-b). 주석 제거본끼리 별도로 diff — 주석만
  // 바뀐 줄은 여기서 애초에 사라진다(위 stripCssComments 참고).
  const oldRaw = sh(`git show ${BASE_REF}:${TARGET_FILE}`);
  const newRaw = readFileSync(path.join(REPO_ROOT, TARGET_FILE), 'utf8');
  const oldStripped = stripCssComments(oldRaw);
  const newStripped = stripCssComments(newRaw);
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'v3-token-diff-'));
  const oldTmp = path.join(tmpDir, 'old.css');
  const newTmp = path.join(tmpDir, 'new.css');
  writeFileSync(oldTmp, oldStripped);
  writeFileSync(newTmp, newStripped);
  let strippedPatch = '';
  try {
    strippedPatch = execSync(`git diff --no-index -U0 -- ${oldTmp} ${newTmp}`, { encoding: 'utf-8' });
  } catch (e) {
    // git diff --no-index exits 1 when there IS a diff — that's expected, not a real error.
    strippedPatch = (e as { stdout?: string }).stdout ?? '';
  }
  const contentLines = parseChangedContentLines(strippedPatch);
  const proofTokenLineChangeCount = countProofTokenLineChanges(contentLines);

  const scope = classifyDiffScope(changedFiles, proofTokenLineChangeCount);
  if (scope.kind === 'out_of_scope') {
    console.log(scope.reason);
    return 0;
  }
  if (scope.kind === 'fail') {
    console.error(scope.reason);
    return 1;
  }
  // scope.kind === 'in_scope' — 토큰 PR 확정, 아래 기존 3축(②③) 그대로.

  const patch = sh(`git diff -U0 ${BASE_REF}...HEAD -- ${TARGET_FILE}`);

  // contentLines는 위(핫픽스 ⓪-b 판정)에서 이미 같은 stripped diff로 구했다 — 재계산
  // 0(같은 git 호출을 두 번 하지 않는다).
  // 주석 제거가 줄 수를 바꿔 `{`/`}`/공백만 있는 줄이 diff 잡음으로 밀릴 수 있다 —
  // 구조 문자뿐인 줄은 "내용 변경"이 아니라 통과(실 값 변경 검사는 RAW_TOKEN_LINE_RE 몫).
  const STRUCTURAL_ONLY_RE = /^[{}\s]*$/;
  const badLines = contentLines.filter(
    (l) => l.trim() !== '' && !RAW_TOKEN_LINE_RE.test(l) && !STRUCTURAL_ONLY_RE.test(l),
  );
  if (badLines.length > 0) {
    console.error('FAIL: globals.css diff(주석 제외)에 --proof-* 원시값 줄이 아닌 변경이 있다(alias·다른 선언 — AC1 위반):');
    for (const l of badLines) console.error(`  "${l}"`);
    return 1;
  }

  const headContent = newRaw;
  const darkRange = findBraceBlockRange(headContent, /^\.dark\s*{/);
  if (darkRange) {
    const hunkRanges = parseHunkNewFileRanges(patch);
    const overlapping = hunkRanges.filter((r) => rangesOverlap(r, darkRange));
    if (overlapping.length > 0) {
      console.error(
        `FAIL: diff가 .dark 블록(줄 ${darkRange[0]}-${darkRange[1]})과 겹친다 — v3는 라이트 전용(doc 3dc24888 §④), 다크는 이 PR에서 무변경이어야 한다.`,
      );
      return 1;
    }
  }

  console.log(`OK: diff 범위 = ${TARGET_FILE} 1개·전 변경 줄이 --proof-* 원시값(또는 주석)·.dark 블록 무변경.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
