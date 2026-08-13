/**
 * story #2611(유나 확定) 회귀가드 — `text-muted-foreground/{alpha}`는 모든 알파 레벨에서
 * AA(4.5:1) 미달이다(실측: 라이트 /80=3.61·/70=2.98·/60=2.48…·solid(/100)만 5.51 통과, 다크도
 * /80조차 bg-muted선 4.18로 깨짐) — `--muted-foreground`(L0.52) 자체가 이미 "AA 겨우 넘는
 * 가장 흐린 본문색"이라 그 아래 legible한 회색은 물리적으로 없다. 더 흐린 위계가 필요하면
 * 대비가 아니라 크기(11px)·굵기(500)·간격으로 표현한다. 89곳(텍스트+아이콘 전부, 유나 확定:
 * 아이콘도 같은 규칙 — "더 조용히"는 알파가 아니라 크기)을 solid로 이관했다.
 *
 * 예외 = "큰 순수 장식"(배경 워터마크류·aria-hidden·인접 텍스트 없음)뿐이고, 그 자리엔
 * `// muted-alpha-ok: <이유>` 주석이 반드시 있어야 통과한다 — 스캐너 자체에 예외를 하드코딩하지
 * 않는다(밸브는 주석으로만, PO 확定). 이유 없는 알파는 없는 셈이다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const MUTED_FG_ALPHA = /text-muted-foreground\/[0-9]+/g;
export const ALPHA_OK_VALVE = /muted-alpha-ok:\s*\S/;

export function findUnexemptedAlphaLines(content: string): number[] {
  const lines = content.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!MUTED_FG_ALPHA.test(line)) return;
    MUTED_FG_ALPHA.lastIndex = 0;
    // 밸브는 같은 줄이나 바로 위 줄(JSX 속성 앞 주석 관용구) 둘 다 허용한다.
    const sameLine = line;
    const prevLine = i > 0 ? lines[i - 1]! : '';
    if (ALPHA_OK_VALVE.test(sameLine) || ALPHA_OK_VALVE.test(prevLine)) return;
    hits.push(i + 1);
  });
  return hits;
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

// verify-no-alpha-focus-ring.ts와 동일 규율 — walk가 조용히 0개를 담으면 위반 0건과 구분이
// 안 돼 헛돌면서 초록불을 내는 사고가 난다. 현재 대상 파일이 894개 안팎이라 500을 하한으로.
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

  const violations: { file: string; lines: number[] }[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    const lines = findUnexemptedAlphaLines(content);
    if (lines.length > 0) violations.push({ file: rel, lines });
  }

  if (violations.length > 0) {
    console.error('FAIL: text-muted-foreground 알파 변형 회귀 발견(story #2611):');
    for (const v of violations) console.error(`  - ${v.file}:${v.lines.join(',')}`);
    console.error(
      '\ntext-muted-foreground/{alpha}는 모든 레벨에서 AA 미달이다(solid만 통과). `/NN` 접미사를' +
        ' 제거하고, 더 흐린 위계가 필요하면 크기·굵기·간격으로 표현한다.' +
        ' 정말 큰 순수 장식(워터마크류·aria-hidden·인접 텍스트 없음)이면 같은 줄이나 바로 위 줄에' +
        ' `// muted-alpha-ok: <이유>` 주석을 남긴다 — 이유 없는 예외는 잡힌다.',
    );
    process.exit(1);
  }

  console.log('OK: text-muted-foreground 알파 회귀 0건');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
