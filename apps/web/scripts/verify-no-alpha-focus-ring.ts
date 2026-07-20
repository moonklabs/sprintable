/**
 * story #2057(유나 규격) 회귀가드 — 포커스 링(box-shadow `ring`)에 알파를 붙이면 대비가
 * 깎인다(실측: 40% 알파 라이트 1.82:1·다크 1.73:1, 100%는 4.77~6.57:1로 전부 AA 3.0 통과).
 * `focus:`/`focus-visible:` 접두 `ring-{color}/{alpha}` 100건(primary 86·ring 8·destructive 5·warning 1)을
 * 전부 알파 제거로 고쳤다 — 이 스크립트는 그 회귀가 재도입되지 않는지 잡는다.
 *
 * 접두 없는 `ring-{color}/{alpha}`(카드 강조·선택 표시 등 장식 링, #2048 lane)은 포커스 표시가 아니라
 * 접근성 요소가 아니다 — 의도적으로 제외한다. `(focus|focus-visible):` 접두가 있을 때만 잡는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// negative lookbehind(식별자 문자 아님) — #1957 md-breakpoint 가드가 화이트리스트 lead-in
// 방식으로 `dark:md:hidden` 같은 복합 variant 체인을 놓쳤던 구멍(까심 QA 지적)과 동형이라
// 처음부터 lookbehind로 잡는다. `sm:focus:ring-primary/40`처럼 다른 variant 뒤에 체이닝돼도
// 직전 문자가 `:`(식별자 아님)이라 매치된다.
// ⚠️ 유나 리뷰 지적: 문자 클래스에 `-`를 넣으면 `group-focus:`/`peer-focus:`(Tailwind에서
// 흔한 부모-포커스 패턴)의 `focus` 직전 `-`가 식별자로 오인돼 매치가 막힌다 — `-`는 Tailwind
// variant 구분자이지 식별자 연속 문자가 아니다. `-`를 뺀다(#1957 구멍을 피하려다 인접한
// 구멍이 남았던 것을 다시 닫음).
export const ALPHA_FOCUS_RING = /(?<![A-Za-z0-9_])(focus|focus-visible):ring-[a-z-]+\/[0-9]+/;

export function hasAlphaFocusRing(content: string): boolean {
  return ALPHA_FOCUS_RING.test(content);
}

const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

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

// PO 지적: walk가 조용히 0개를 담아도(cwd 오류·src 경로 이동·모노레포 구조 변경) 위반 0건과
// 구분이 안 돼 "OK: 회귀 0건"이 찍히며 통과해버린다 — 가드가 아무것도 검사 안 하고 초록불을
// 내는 사고. 오늘 민군이 같은 함정(와이어 가드 커맨드/인자 미검출)을 막은 것과 동형이라
// 자체 단언을 건다. 현재 src 아래 대상 파일이 894개라 500을 하한으로 — 정상 성장/축소는
// 여유 있게 허용하면서 "walk가 사실상 아무것도 못 찾은" 상태만 잡는다.
const MIN_EXPECTED_FILES = 500;

function main(): void {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const files: string[] = [];
  walk(srcRoot, files);

  if (files.length < MIN_EXPECTED_FILES) {
    console.error(
      `FAIL: 검사 대상 파일이 ${files.length}개뿐 — 경로/실행 위치가 틀렸을 가능성. 가드가 헛돌고 있다.`,
    );
    console.error(`  srcRoot=${srcRoot} (기대 최소 ${MIN_EXPECTED_FILES}개)`);
    process.exit(1);
  }

  const violations: string[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    if (hasAlphaFocusRing(content)) violations.push(rel);
  }

  if (violations.length > 0) {
    console.error('FAIL: 포커스 링에 알파가 붙은 자리 발견(story #2057 회귀):');
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\n포커스 링에 알파를 붙이면 대비가 깎인다(실측: 40% 알파 최악 1.7:1대, 100%는 4.7:1 이상).' +
        ' `focus:ring-*` / `focus-visible:ring-*`는 알파 없이 쓴다 — 색은 유지하고 `/NN` 접미사만 제거한다.',
    );
    process.exit(1);
  }

  console.log('OK: 포커스 링 알파 회귀 0건');
}

// 직접 실행(tsx scripts/verify-no-alpha-focus-ring.ts)일 때만 파일시스템 스캔 — vitest가
// hasAlphaFocusRing을 import할 때는 이 부작용이 돌지 않아야 한다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
