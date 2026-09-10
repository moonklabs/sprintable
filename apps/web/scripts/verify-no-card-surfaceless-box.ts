/**
 * story #3785(PO 실측 2026-09-10 09:43Z·10:47Z 재실측) — 페이지 배경(`--background`) 위에
 * 바로 놓이는 «테두리만 있는 상자»(카드 표면 `bg-card` 미적용)의 «신규 증가»만 막는
 * baseline-freeze 회귀가드. 기전은 verify-no-new-raw-button.ts(story #3164)와 동일 —
 * count-per-file + 외부 JSON baseline + self-assert(새 기전 발명 금지, 팀 관례).
 *
 * ⚠️ 이 가드는 **보조**다 — 라이브 DOM 하네스(e2e/card-surface-guard.spec.ts, 판정선 5조건
 * + 라우트별 양성대조 3종)가 «주» 가드이고 실 판정 authority다. 이 정적 정규식은 PO가
 * 원 신고에 쓴 방식 그대로(`className="…rounded-(md|lg|xl) border border-border…"`이고
 * `bg-` 없는 자리)를 코드화한 **상한**이지 실수가 아니다 — `cn()` 조합을 못 보고, 템플릿
 * 리터럴 className을 못 보고, 「이미 카드 안에 든 상자」(라이브 하네스 조건⑤가 거기서
 * 자동으로 걷어내는 2층)를 못 가른다. 정적 상한과 라이브 실측은 단위가 다르다 — 대소를
 * 비교하지 않는다(story #3785 유나 定 본문 그대로).
 *
 * ## 비목표
 * 이 baseline에 등재된 기존 자리를 전량 Card/SectionCard로 마이그레이션하지 않는다 —
 * 이 가드는 오직 «더 늘지 않는다»만 보장한다(개별 수리는 후속 스윕 판).
 *
 * ⚠️이 가드가 «못 잡는» 것(과잉 확장 방지, 선언 없이 초록이면 「전부 봤다」로 오독 방지):
 *   ㉠ count-per-file이라 같은 파일 안에서 1지우고1추가하면 순증가가 0으로 상쇄된다.
 *   ㉡ `cn(...)` 헬퍼로 조합된 className(`rounded-*`와 `border border-border`가 서로
 *     다른 인자·다른 표현식에 나뉜 자리)은 정규식이 한 문자열 리터럴만 보므로 못 잡는다.
 *   ㉢ 템플릿 리터럴(`` className={`...`} ``)·조건부 클래스(`clsx`/삼항)는 대상 밖 —
 *     이 가드는 JSX `className="..."` 이중따옴표 문자열 리터럴만 본다.
 *   ㉣ 이미 카드 표면 안(2층)에 정당하게 든 border-only 상자도 이 정규식 자체로는
 *     구분 못 한다(그래서 baseline에 「카드 안이라 정당」 항목이 섞일 수 있다 — 라이브
 *     하네스의 조건⑤만이 그 구분을 실제로 진다). 이 가드 단독으로 pass/fail 최종 판정을
 *     내리지 않는다(주 가드와 함께 읽을 것).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;

// className="..." 이중따옴표 문자열 리터럴만 본다(위 ㉢ 참고). rounded-(md|lg|xl) +
// border border-border(선택적 알파 접미 /NN, story #3785 유나 실측 — rewards의
// border-border/60 변형) 조합이 있으면서 그 같은 문자열 안에 bg-가 전혀 없어야 위반.
const CLASSNAME_ATTR_RE = /className="([^"]*)"/g;
const HAS_ROUNDED_BORDER_RE = /rounded-(?:md|lg|xl)\b.*\bborder\s+border-border(?:\/\d+)?\b|border\s+border-border(?:\/\d+)?\b.*\brounded-(?:md|lg|xl)\b/;
const HAS_BG_RE = /\bbg-/;

export function countSurfacelessBoxClasses(content: string, file: string): number {
  if (TEST_RE.test(file)) return 0;
  let count = 0;
  for (const m of content.matchAll(CLASSNAME_ATTR_RE)) {
    const cls = m[1];
    if (HAS_ROUNDED_BORDER_RE.test(cls) && !HAS_BG_RE.test(cls)) count++;
  }
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

// .tsx만 스캔(className JSX 속성 — .ts는 대상 밖). story #3164 관례와 동형 self-assert.
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
    const n = countSurfacelessBoxClasses(content, rel);
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'card-surfaceless-box-baseline.json');

interface BaselineFile {
  _comment: string[];
  counts: Record<string, number>;
}

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

// main()과 .test.ts가 같은 실물을 부르게 한다(story #3164 PR#3580 페드루 지적과 동형 —
// 막는 쪽과 재는 쪽이 다른 코드를 보면 드리프트를 못 잡는다).
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
    counts = scanRepoCounts(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);

  const totalOcc = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[story #3785 보조] 카드 표면 미적용 클래스 스캔 — 해당 자리 있는 파일 ${counts.size}개/${totalOcc}건 · ` +
      `baseline(grandfather) ${baseline.size}개 파일 — ⚠️정적 상한, 라이브 하네스(e2e/card-surface-guard.spec.ts)가 주 가드`,
  );

  const overages = computeOverages(counts, baseline);

  const staleBaseline = [...baseline.keys()].filter((f) => !counts.has(f));
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ baseline에 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는) 파일: ${staleBaseline.length}개`);
  }

  if (overages.length > 0) {
    console.error('\nFAIL: baseline을 초과한 카드-표면-미적용 클래스 발견(story #3785 회귀 — 신규 자리는 Card/SectionCard로):');
    for (const o of overages.sort((a, b) => a.file.localeCompare(b.file))) {
      console.error(`  - ${o.file}: ${o.count}건(허용 ${o.allowed}건)`);
    }
    console.error(
      '\n→ `Card`/`SectionCard`(@/components/ui/card, surface=\'solid\')로 바꾸거나, 이미 카드 안(2층)이라 ' +
        '정당한 자리면 baseline 등재 사유를 주석에 남길 것(PO 승인 — story #3785 유나 定 본문 §① 예외 명단).',
    );
    return 1;
  }

  console.log('\nOK: baseline 초과 없음(0건 증가 — «전부 깨끗»이 아니라 «안 늘었다»는 뜻).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const counts = scanRepoCounts(SRC_ROOT);
    const sorted = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const out: BaselineFile = {
      _comment: [
        'story #3785(PO 실측 2026-09-10) grandfather baseline — 이 가드 첫 도입 시점 develop의 기존 ' +
          '카드-표면-미적용 클래스(className="…rounded-(md|lg|xl) border border-border(/NN)?…" · bg- 없음).',
        '마이그레이션 대상 아님 — 이 게이트는 "더 늘지 않는다"만 보장한다(freeze, 전량 정리는 후속 스윕 판).',
        '정적 상한이지 실수가 아니다 — 라이브 하네스(e2e/card-surface-guard.spec.ts)가 주 가드, 이 baseline은 보조.',
      ],
      counts: sorted,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
