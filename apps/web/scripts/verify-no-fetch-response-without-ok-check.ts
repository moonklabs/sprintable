/**
 * story #3688(3687→3686 그라운딩, 3680 클래스) — `fetchWithAuth(...)` 응답을 `r.ok` 검사
 * 없이 바로 `.json()`으로 파싱해 "데이터"로 쓰는 자리를 막는다. 이 클래스의 실제 증상은
 * story #3680(agent-runs-list.tsx)·#3687(chat-input.tsx)에서 두 번 확인됐다 — BE가 422를
 * 돌려줘도 이 소비 패턴은 그 에러 바디를 그대로 "성공 데이터"로 취급해(`json.data`가
 * undefined) `?? []`로 조용히 빈 목록이 된다. 처방 패턴은 매번 같다 —
 * `if (!res.ok) throw new Error(...)`(또는 실패 상태를 명시적으로 얹는다) 뒤에 `.json()`.
 *
 * 3687 그라운딩(1회성 python 스크립트)이 apps/web 전체에서 이 형태 28곳(파일 18개)을
 * 셌다 — 그 카운트를 CI 상시 가드로 승격한다.
 *
 * ## 두 소비 형태
 *   ㉠ 체이닝 — `fetchWithAuth(...).then(r => r.json())` (중간에 `.then(r => { if(!r.ok)... })`
 *      같은 별도 단계 없이 바로 json()으로 감).
 *   ㉡ await+분리 — `const res = await fetchWithAuth(...)` 뒤, 같은 변수의 `.ok`/`!res.ok`
 *      검사 없이 `res.json()`을 호출(윈도우 300자 안).
 *
 * ## 허용목록 — 파일+«그 줄의 트림된 텍스트» 키(줄번호 아님)
 * 다른 곳에 줄을 끼워 넣어도(line 번호가 밀려도) 이 키는 안 흔들린다 — self-test ㉡이
 * 정확히 이걸 증명한다. baseline-freeze 관례(verify-no-new-raw-fetch-api.ts와 동형) —
 * 기존 28곳은 얼리고, baseline 밖의 새 자리만 막는다(새 자리 0). baseline에 남아있는데
 * 이번 스캔에서 안 걸린 항목(=고쳐진 자리)은 FAIL로 승격한다(advisory 아님) — "허용목록은
 * 줄어들기만" 원칙을 스크립트가 강제한다(고치고 목록에서 안 지우면 stale로 걸린다).
 *
 * ## ⚠️이 가드가 «못 잡는» 것
 *   ㉢ `fetchWithAuth`가 아닌 raw `fetch()`(verify-no-new-raw-fetch-api.ts의 관할).
 *   ㉣ `.ok` 검사가 있지만 실패 분기에서 여전히 `.json()`을 부르는 경우(검사 "존재
 *      여부"만 봄 — 검사 로직이 올바른지는 검산 대상 아님).
 *   ㉤ await+분리 형에서 변수명이 아예 다른 스코프 재사용 등으로 300자 윈도우를 벗어나면
 *      과소탐지(놓침) 가능 — "결함 목록"이 아니라 "열어 볼 목록"에 가깝다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.tsx?$/;
const TEST_RE = /\.test\.[tj]sx?$/;

const CHAIN_RE = /fetchWithAuth\([^)]*\)\s*\.then\(\s*\(?\s*(\w*)\s*\)?\s*=>\s*\1\??\.?json\(\)/g;
const AWAIT_ASSIGN_RE = /(\w+)\s*=\s*await\s+fetchWithAuth\(/g;
const WINDOW = 300;

export interface FetchOkViolation {
  file: string;
  key: string;
  line: string;
}

function lineTextAt(content: string, index: number): string {
  const lineStart = content.lastIndexOf('\n', index) + 1;
  let lineEnd = content.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = content.length;
  return content.slice(lineStart, lineEnd).trim();
}

export function findFetchOkViolations(content: string, file: string): FetchOkViolation[] {
  const violations: FetchOkViolation[] = [];
  const seenKeys = new Set<string>();

  CHAIN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHAIN_RE.exec(content)) !== null) {
    const line = lineTextAt(content, m.index);
    const key = `${file}::${line}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    violations.push({ file, key, line });
  }

  AWAIT_ASSIGN_RE.lastIndex = 0;
  while ((m = AWAIT_ASSIGN_RE.exec(content)) !== null) {
    const varName = m[1]!;
    const windowText = content.slice(m.index, m.index + WINDOW);
    const hasJson = windowText.includes(`${varName}.json()`);
    const hasOkCheck = windowText.includes(`${varName}.ok`) || windowText.includes(`!${varName}.ok`);
    if (!hasJson || hasOkCheck) continue;
    const line = lineTextAt(content, m.index);
    const key = `${file}::${line}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    violations.push({ file, key, line });
  }

  return violations;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      if (path.relative(SRC_ROOT, full) === 'app/api') continue; // BFF 라우트 자신(호출부 아님).
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

const MIN_EXPECTED_FILES = 400;

export function scanRepo(srcRoot: string): FetchOkViolation[] {
  const files: string[] = [];
  walk(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const out: FetchOkViolation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    out.push(...findFetchOkViolations(content, rel));
  }
  return out;
}

const BASELINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fetch-response-without-ok-check-baseline.json',
);

interface BaselineFile {
  _comment: string[];
  keys: string[];
}

export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Set(parsed.keys ?? []);
  } catch {
    return new Set();
  }
}

// ─── self-test 픽스처(라이브 파일 무의존 — 다른 PR이 실 파일을 고쳐도 self-test는 항상
// 같은 값을 내야 한다, verify-repeated-row-action-names.ts AC5와 동형 이유) ───

const FIXTURE_VIOLATION = `
async function loadFoo() {
  const res = await fetchWithAuth('/api/foo');
  const data = await res.json();
  return data;
}
`;

// 위와 완전히 같은 위반 줄이지만, «관계없는 줄」을 위에 여럿 끼워 넣어 줄 번호를 밀었다 —
// 파일+줄번호가 키였다면 이 두 픽스처가 다른 키를 냈을 것(self-test ㉡).
const FIXTURE_VIOLATION_WITH_UNRELATED_LINES_INSERTED = `
// 관계없는 주석 한 줄
const UNRELATED_CONSTANT = 42;
async function loadFoo() {
  // 관계없는 주석 한 줄 더
  const res = await fetchWithAuth('/api/foo');
  const data = await res.json();
  return data;
}
`;

const FIXTURE_FIXED = `
async function loadFoo() {
  const res = await fetchWithAuth('/api/foo');
  if (!res.ok) throw new Error(\`load failed \${res.status}\`);
  const data = await res.json();
  return data;
}
`;

const FIXTURE_CHAIN_VIOLATION = `
function loadBar() {
  return fetchWithAuth('/api/bar').then((r) => r.json());
}
`;

export function runSelfTest(): boolean {
  const before = findFetchOkViolations(FIXTURE_VIOLATION, 'fixture.ts');
  const shifted = findFetchOkViolations(FIXTURE_VIOLATION_WITH_UNRELATED_LINES_INSERTED, 'fixture.ts');
  const fixed = findFetchOkViolations(FIXTURE_FIXED, 'fixture.ts');
  const chain = findFetchOkViolations(FIXTURE_CHAIN_VIOLATION, 'fixture.ts');

  const check1 = before.length === 1;
  // ㉡ 핵심 — 줄이 밀려도(다른 라인 삽입) 같은 키가 나온다(줄번호 키였다면 달랐을 것).
  const check2 = shifted.length === 1 && before[0]?.key === shifted[0]?.key;
  const check3 = fixed.length === 0;
  const check4 = chain.length === 1;

  console.log(
    `[self-test] 위반 삽입=${before.length}건(기대 1) · 무관 줄 삽입 내성=${shifted.length === 1 ? '유지' : '깨짐'}` +
      `(같은 키: ${check2}) · 처방 뒤=${fixed.length}건(기대 0) · 체이닝 형=${chain.length}건(기대 1)`,
  );
  return check1 && check2 && check3 && check4;
}

function main(): number {
  if (process.argv.includes('--selftest')) {
    const ok = runSelfTest();
    if (!ok) {
      console.error('\nFAIL: self-test 자체 대조 실패 — 아래 실제 스윕 결과를 믿지 않는다(가드 로직이 깨졌을 가능성).');
      return 2;
    }
  }

  let violations: FetchOkViolation[];
  try {
    violations = scanRepo(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);
  const foundKeys = new Set(violations.map((v) => v.key));

  const newViolations = violations.filter((v) => !baseline.has(v.key));
  const staleBaseline = [...baseline].filter((k) => !foundKeys.has(k));

  console.log(
    `[story #3688] fetchWithAuth 응답 .ok 미검사 스캔 — 위반 ${violations.length}건 · ` +
      `baseline(grandfather) ${baseline.size}건`,
  );

  let failed = false;

  if (newViolations.length > 0) {
    failed = true;
    console.error(`\n❌ 신규 위반 ${newViolations.length}건 — 처방: if (!res.ok) throw ...(또는 실패 상태 표시) 뒤에 .json():`);
    for (const v of newViolations.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${v.file}: ${v.line}`);
    }
  }

  if (staleBaseline.length > 0) {
    failed = true;
    console.error(`\n❌ baseline에 있으나 이번 스캔에서 안 걸린(고쳐진) 항목 ${staleBaseline.length}건 — 허용목록에서 제거할 것(줄어들기만 원칙):`);
    for (const k of staleBaseline.sort()) {
      console.error(`  - ${k}`);
    }
  }

  if (failed) {
    console.error(
      '\n→ 새 자리면 fetch 소비를 처방 패턴으로 고치거나(권장), 정말 예외면 PO 승인 뒤' +
        ' fetch-response-without-ok-check-baseline.json에 등재. stale이면 그 키를 baseline에서 지울 것.',
    );
    return 1;
  }

  console.log('\nOK: 새 자리 0건·stale 0건(허용목록이 실제 코드 상태와 정확히 일치).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const violations = scanRepo(SRC_ROOT);
    const keys = [...new Set(violations.map((v) => v.key))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3688 grandfather baseline — 이 가드 첫 도입 시점 develop의 기존',
        'fetchWithAuth 응답 .ok 미검사 자리(3687 그라운딩 28곳). 새 자리 0을 보장하고,',
        '고쳐진 항목은 여기서 지운다(stale이면 가드가 FAIL — 줄어들기만 원칙 강제).',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
