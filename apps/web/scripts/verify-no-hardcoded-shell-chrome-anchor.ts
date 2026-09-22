/**
 * story #4131 — #4130이 split-pane 5곳(goals·sprints·settings·inbox·docs 레이아웃)의 로컬
 * 뷰포트 앵커에 `h-[calc(100svh-3rem)]`를 하드코딩했다. `3rem`은 TopBar(h-12) 높이뿐이라
 * TopBar가 안 그려지는 라우트(`/settings`)나 모바일(<1024px, 하단 고정 탭바)에서 값이 틀렸다.
 * `--shell-chrome-h`(globals.css `@layer components`, `.dashboard-shell-root`)가 그 둘을
 * CSS만으로 합성하는 SSOT다 — 앵커는 전부 `h-[calc(100svh-var(--shell-chrome-h))]`로만
 * 써야 한다.
 *
 * 이 가드는 `calc(100svh-3rem)`(또는 공백 변형) 패턴이 실 소스(.tsx/.ts, globals.css 밖)에
 * 다시 나타나면 즉시 FAIL한다 — "0 초과 즉시 FAIL"(baseline 없음, story #4125/#3758과 같은
 * 급 — 하드코딩 재유입은 grandfather로 얼릴 채무가 아니라 발견 즉시 고치는 성질).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
// story #4131 헤더 주석이 역사적 맥락으로 `3rem`을 언급한다(하드코딩 값 자체가 아니라 그
// 값이 왜 틀렸는지 설명) — 실 사용(className 문자열) vs 문서화(주석) 혼동을 피하려면
// globals.css는 스코프 밖(이 파일의 실 선언은 이미 var(--shell-chrome-h)뿐, verify-no-
// unlayered-css-class.test.ts가 별도로 그 사실을 pin한다).
const EXCLUDE_FILES = new Set(['globals.css']);
const HARDCODED_RE = /calc\(100svh\s*-\s*3rem\)/;

export interface HardcodedAnchorHit {
  file: string;
  line: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

export function findHardcodedShellChromeAnchors(srcRoot: string): HardcodedAnchorHit[] {
  const hits: HardcodedAnchorHit[] = [];
  for (const file of walk(srcRoot)) {
    if (EXCLUDE_FILES.has(path.basename(file))) continue;
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (HARDCODED_RE.test(line)) {
        hits.push({ file: path.relative(srcRoot, file), line: i + 1 });
      }
    });
  }
  return hits;
}

function main(): number {
  const hits = findHardcodedShellChromeAnchors(SRC_ROOT);
  if (hits.length > 0) {
    console.error('FAIL: calc(100svh-3rem) 하드코딩 재유입 발견(story #4131 회귀):');
    for (const h of hits) console.error(`  ${h.file}:${h.line}`);
    console.error(
      '\nTopBar 표시 여부·모바일 탭바를 반영 못 하는 하드코딩 3rem 대신 ' +
        'h-[calc(100svh-var(--shell-chrome-h))]를 쓴다(globals.css --shell-chrome-h SSOT).',
    );
    return 1;
  }
  console.log('OK: calc(100svh-3rem) 하드코딩 0건.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
