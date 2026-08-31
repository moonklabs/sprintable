/**
 * story #3164(DS 게이트 키스톤, doc DS 게이트 키스톤 규격 43ce3a71) — raw `<button>`(소문자)의
 * «신규 증가»만 막는 baseline-freeze 회귀가드. 캐노니컬 프리미티브는
 * `Button`(components/ui/button.tsx) — 사전 스터디 진전 v2 §2b가 실측으로 세운 「프리미티브
 * 존재 ≠ 채택, 채택 강제는 게이트뿐」의 집행체다: S1/S2로 `Button`은 이미 섰지만 raw
 * `<button>`은 게이트 부재 축에서 7일간 502→552건으로 계속 늘었다.
 *
 * 기전은 verify-no-new-raw-fetch-api.ts(story #2691, EXEMPT_FILES+정규식 스캔)와
 * verify-no-new-tint-color-text.ts(story #2420, 외부 JSON baseline+self-assert)를 그대로
 * 합친 것 — 새 기전 발명 금지(PO 지시).
 *
 * ## 비목표
 * 기존 raw `<button>` 552건을 `Button`으로 마이그레이션하지 않는다 — 이 가드는 오직
 * «더 늘지 않는다»만 보장한다(baseline은 얼린 채무, 개별 수리는 후속 표면 리팩터 판).
 *
 * ⚠️이 가드가 «못 잡는» 것(과잉 확장 방지, 선언 없이 초록이면 「전부 봤다」로 읽힌다):
 *   ㉠ count-per-file이라 같은 파일 안에서 1지우고1추가하면 순증가가 0으로 상쇄된다 —
 *     "이 자리가 늘었다"가 아니라 "이 파일의 총량이 늘었다"만 잰다.
 *   ㉡ `asChild` prop 오용(Button을 감싸 실제로는 다른 요소를 렌더하는 패턴)은 대상 밖 —
 *     이 가드는 소스의 리터럴 `<button` 태그명만 본다.
 *   ㉢ 기존 552건이 "정당한 raw button"인지는 이 가드가 판정하지 않는다(grandfather는
 *     "안다"이지 "옳다"가 아니다).
 *   ㉣ 동적으로 조립되는 태그명(`React.createElement('button', ...)` 등)은 못 잡는다 —
 *     JSX 리터럴 `<button` 표기만 정규식으로 본다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;

// 프리미티브·구조적 자리 — 캐노니컬 Button을 «구현하는» 파일이거나, Button으로 못 바꾸는
// 구조적 이유(base-ui 프리미티브 wrapper 등)가 있는 파일. baseline에도 안 실린다("언젠가
// 고쳐야 할 채무"가 아니라 "raw button이 정당한 자리"이기 때문).
export const EXEMPT_FILES = new Set<string>([
  'components/ui/button.tsx', // 캐노니컬 Button 자신의 구현.
  'components/ui/sidebar.tsx', // base-ui 프리미티브 트리거 wrapper — 구조적으로 raw button 필요.
  'components/ui/toast.tsx', // 토스트 dismiss 트리거 — 최소 마크업 프리미티브.
  'components/ui/route-error-state.tsx', // 에러 화면 재시도 트리거 — 최소 마크업.
  'components/ui/contextual-panel-layout.tsx', // 패널 닫기/토글 트리거 — 구조적 오버레이 마크업.
  'components/ui/operator-dropdown-select.tsx', // 커스텀 드롭다운 트리거 프리미티브.
  'components/ui/upgrade-modal.tsx', // 모달 닫기 트리거 — 최소 마크업.
]);

// JSX 리터럴 `<button`(소문자, 단어 경계 — `<ButtonGroup`류 오탐 방지)만 본다.
const RAW_BUTTON_RE = /<button(?=[\s/>])/g;

export function countRawButtons(content: string, file: string): number {
  if (EXEMPT_FILES.has(file) || TEST_RE.test(file)) return 0;
  let count = 0;
  for (const _m of content.matchAll(RAW_BUTTON_RE)) count++;
  return count;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

// .tsx만 스캔(JSX 태그 판정 — .ts는 대상 밖). 2026-08-28 실측 443개(테스트 제외).
// story #2057류 함정(walk가 조용히 0개를 담아도 위반 0건과 구분 안 됨) 방지 — 이 self-assert를
// `main()`이 아니라 이 함수 자체에 박아 `--write-baseline` 경로도 똑같이 지킨다(tint 가드
// scanRepo와 동일 계약 — 재료가 없으면 baseline 생성 자체를 거부해야, «빈 재료로 빈 baseline을
// 조용히 얼려버리는» 사고를 원천 차단한다).
const MIN_EXPECTED_FILES = 400;

export function scanRepoCounts(srcRoot: string): Map<string, number> {
  const files: string[] = [];
  walk(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const counts = new Map<string, number>();
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    const n = countRawButtons(content, rel);
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'raw-button-baseline.json');

interface BaselineFile {
  _comment: string[];
  counts: Record<string, number>;
}

// story #2864(#2093 lint_query_sentinel_direct_calls.py와 동일 계약) — 파일이 없으면 빈
// baseline(모든 raw button이 신규로 잡힘)으로 취급, 조용히 스킵하지 않는다.
export function loadBaseline(filePath: string): Map<string, number> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Map(Object.entries(parsed.counts ?? {}));
  } catch {
    return new Map();
  }
}

export interface Overage {
  file: string;
  count: number;
  allowed: number;
}

// 페드루 PO 리뷰 지적(PR#3580) — main()의 초과판정 루프를 테스트가 따로 복제(judge())해
// 재고 있으면 「막는 쪽과 재는 쪽이 다른 코드를 본다」 구조가 돼, main() 로직이 드리프트해도
// 테스트는 계속 green으로 남는다(Gate B는 이미 실 scanContent를 부르므로 이 함정이 없었다).
// export해 main()과 .test.ts가 같은 실물을 부르게 한다.
export function computeOverages(counts: Map<string, number>, baseline: Map<string, number>): Overage[] {
  const overages: Overage[] = [];
  for (const [file, count] of counts) {
    const allowed = baseline.get(file) ?? 0;
    if (count > allowed) overages.push({ file, count, allowed });
  }
  return overages;
}

function main(): number {
  let counts: Map<string, number>;
  try {
    counts = scanRepoCounts(SRC_ROOT); // self-asserts MIN_EXPECTED_FILES 내부에서.
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);

  const totalOcc = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[DS 게이트 A] raw <button> 스캔 — raw button 있는 파일 ${counts.size}개/${totalOcc}occ · ` +
      `baseline(grandfather) ${baseline.size}개 파일`,
  );

  const overages = computeOverages(counts, baseline);

  const staleBaseline = [...baseline.keys()].filter((f) => !counts.has(f));
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ baseline에 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는) 파일: ${staleBaseline.length}개`);
  }

  if (overages.length > 0) {
    console.error('\nFAIL: baseline을 초과한 raw <button> 발견(story #3164 회귀 — 신규 raw button은 Button으로):');
    for (const o of overages.sort((a, b) => a.file.localeCompare(b.file))) {
      console.error(`  - ${o.file}: ${o.count}건(허용 ${o.allowed}건)`);
    }
    console.error(
      '\n→ `Button`(@/components/ui/button)으로 바꾸거나, 구조적으로 raw button이 정당한 프리미티브 ' +
        '자리(base-ui wrapper 등)면 EXEMPT_FILES에 등재(PO 승인).',
    );
    return 1;
  }

  console.log('\nOK: baseline 초과 없음(0건 증가 — «전부 깨끗»이 아니라 «안 늘었다»는 뜻).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    // story #2710 재생성 방식과 동일 계약(can-only-shrink 메타가드 없음) — 가드 도입 시점
    // develop 스냅샷을 freeze한다.
    const counts = scanRepoCounts(SRC_ROOT);
    const sorted = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const out: BaselineFile = {
      _comment: [
        'story #3164(DS 게이트 키스톤) grandfather baseline — 이 가드 첫 도입 시점 develop의 기존 raw <button>.',
        '마이그레이션 대상 아님 — 이 게이트는 "더 늘지 않는다"만 보장한다(freeze, 개별 수리는 후속 표면 리팩터 판).',
      ],
      counts: sorted,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
