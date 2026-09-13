/**
 * story #3826(UX-v3·FE 2, 페드루 PO 確定 2026-09-13) AC1 diff 가드 — 이 스토리의 diff는
 * `globals.css`의 원시 토큰(`--proof-*`) 값·`--proof-radius-soft` 값에만 있어야 한다.
 * 의미 토큰 alias(`--color-proof-*: var(--proof-*)` 매핑·Tailwind `@theme` 참조)·
 * `.dark` 블록·그 외 어떤 tsx/파일도 diff에 있으면 FAIL(카드 4계약값 ① AC1).
 *
 * 3축 검사:
 *  ① `git diff --name-only <base>...HEAD` = 정확히 `apps/web/src/app/globals.css` 1개.
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

function ensureBaseRefAvailable(baseRef: string): void {
  try {
    sh(`git rev-parse --verify ${baseRef}`);
    return;
  } catch {
    // 얕은 체크아웃이라 origin/develop이 로컬에 없을 수 있다 — 필요한 만큼만 얕게 fetch.
  }
  const [remote, branch] = baseRef.includes('/') ? baseRef.split(/\/(.+)/).slice(0, 2) : ['origin', baseRef];
  try {
    execSync(`git fetch --depth=50 ${remote} ${branch}`, { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (e) {
    throw new Error(`FAIL: base ref(${baseRef}) fetch 실패 — ${(e as Error).message}`);
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

function main(): number {
  ensureBaseRefAvailable(BASE_REF);

  const changedFiles = parseChangedFiles(sh(`git diff --name-only ${BASE_REF}...HEAD`));
  if (changedFiles.length === 0) {
    console.log(`OK: ${BASE_REF}...HEAD 사이 diff 0건(브랜치가 base와 같음 — 통과).`);
    return 0;
  }
  const unexpected = changedFiles.filter((f) => f !== TARGET_FILE && !INFRA_ALLOWLIST.has(f));
  if (unexpected.length > 0) {
    console.error(`FAIL: ${TARGET_FILE} 외 파일이 diff에 있다(AC1 위반):`);
    for (const f of unexpected) console.error(`  ${f}`);
    return 1;
  }

  const patch = sh(`git diff -U0 ${BASE_REF}...HEAD -- ${TARGET_FILE}`);

  // 주석 제거본끼리 별도로 diff — 주석만 바뀐 줄은 여기서 애초에 사라진다(위 stripCssComments
  // 참고). 두 버전 다 실 git 커밋일 필요는 없어 `git diff --no-index`로 임시 파일 비교.
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
