/**
 * story 5048 ③d — `verify:no-hardcoded-design-values` : 박힌 디자인 값 래칫 가드.
 *
 * 키트 규칙(간격 4/8/12/16/24/32 · 조작 높이 40 · 글자 16 · 그림자 0 · 색은 역할 토큰)에서 벗어난 «값이 박힌 클래스»를 분류별로 세어(measure — hardcoded-design-values.ts)
 * `hardcoded-design-values-baseline.json`에 못 박는다. **센 수가 기준선보다 늘면 RED**(새 박힌 값 · 옛 별칭 색의 «새 사용»이 못 들어옴).
 * 줄면: `strict` 분류는 RED(기준선을 같이 줄이게 — «고쳤으면 목록에서 개수를 맞출 것»), 큰 수 분류(옛 별칭 색 · 작은 글자 정의)는 경고만(남의 PR이 우연히 줄여도 막지 않음 — 기준선은 다음 정리 때 줄임).
 * 이 가드는 «허용 목록»이 아니다 — 허용 목록(토큰 밖이 맞는 곳)은 색 값 직접 가드(styles/color-literals.5048.test.ts)에만 있고, 여기 기준선은 «아직 못 걷은 빚의 크기»다.
 * 기준선을 올리는 diff는 PO 확인 대상.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, measureTree, type Counts } from './hardcoded-design-values.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../src');
const BASELINE_PATH = path.join(HERE, 'hardcoded-design-values-baseline.json');

export interface Drift { id: string; baseline: number; actual: number; }
export interface Comparison { increased: Drift[]; stale: Drift[]; slack: Drift[]; }

/** 기준선과 실측을 견준다. increased = 늘었다(FAIL) · stale = strict 분류가 줄었다(FAIL) · slack = 큰 수 분류가 줄었다(경고). */
export function compareToBaseline(actual: Counts, baseline: Counts): Comparison {
  const increased: Drift[] = []; const stale: Drift[] = []; const slack: Drift[] = [];
  for (const c of CATEGORIES) {
    const a = actual[c.id] ?? 0; const b = baseline[c.id];
    if (b === undefined) { increased.push({ id: c.id, baseline: 0, actual: a }); continue; }
    if (a > b) increased.push({ id: c.id, baseline: b, actual: a });
    else if (a < b) (c.strict ? stale : slack).push({ id: c.id, baseline: b, actual: a });
  }
  return { increased, stale, slack };
}

export function loadBaseline(): Counts {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { counts: Counts };
  return raw.counts;
}

function main(): number {
  const actual = measureTree(SRC_ROOT);
  if (process.argv.includes('--print')) { console.log(JSON.stringify(actual, null, 2)); return 0; }
  const baseline = loadBaseline();
  const { increased, stale, slack } = compareToBaseline(actual, baseline);
  const label = (id: string) => CATEGORIES.find((c) => c.id === id)!;
  console.log('[5048 ③d] 박힌 디자인 값 — ' + CATEGORIES.map((c) => `${c.id} ${actual[c.id]}`).join(' · '));
  for (const s of slack) console.log(`  ℹ ${s.id}: 기준선 ${s.baseline} → 실측 ${s.actual}(줄었음 — 다음 정리 때 기준선을 줄이면 됨)`);
  if (increased.length === 0 && stale.length === 0) { console.log('OK: 새 박힌 값 0 (기준선 이하).'); return 0; }
  for (const d of increased) {
    const c = label(d.id);
    console.error(`❌ ${d.id} — ${c.label}: 기준선 ${d.baseline} → 실측 ${d.actual} (+${d.actual - d.baseline}). 새로 박지 말 것 — ${c.how}.`);
  }
  for (const d of stale) {
    console.error(`❌ ${d.id} — 기준선 ${d.baseline} → 실측 ${d.actual}: 걷었으니 hardcoded-design-values-baseline.json에서 개수를 맞출 것(줄기만 하게 못 박는 래칫).`);
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
