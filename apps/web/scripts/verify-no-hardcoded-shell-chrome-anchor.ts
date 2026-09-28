/**
 * story #4131 — #4130이 split-pane 5곳(goals·sprints·settings·inbox·docs 레이아웃)의 로컬
 * 뷰포트 앵커에 `h-[calc(100svh-3rem)]`를 하드코딩했다. `3rem`은 TopBar(h-12) 높이뿐이라
 * TopBar가 안 그려지는 라우트(`/settings`)나 모바일(<1024px, 하단 고정 탭바)에서 값이 틀렸다.
 * `--shell-chrome-h`(globals.css `@layer components`, `.dashboard-shell-root`)가 그 둘을
 * CSS만으로 합성하는 SSOT다 — 앵커는 전부 `h-[calc(100svh-var(--shell-chrome-h))]`로만
 * 써야 한다.
 *
 * ⚠️CHANGES-1(페드루 PO 지적, 2026-09-22 01:24Z) — 원래 정규식(`calc\(100svh\s*-\s*3rem\)`
 * 글자꼴 그대로만)은 `100dvh`/`100lvh`/`100vh` 변형, `48px`(탭바 높이 하드코딩), `var(--
 * mobile-tab-bar-h)`(변수는 맞는데 SSOT 변수가 아님), 다항 조합(`calc(100svh - 3rem -
 * var(--mobile-tab-bar-h))`)을 전부 놓쳤다 — 전부 "뷰포트 높이에서 뭔가를 직접 빼는" 같은
 * 실패 클래스인데 글자꼴 하나만 봐서 새는 통로가 4개 이상 있었다. 이제는 `calc(100{s|d|l}?
 * vh - <표현식>)` 형태를 전수 찾아 그 `<표현식>`이 정확히 `var(--shell-chrome-h)` 하나가
 * 아니면 전부 FAIL한다(허용은 그 한 가지뿐 — 부분 일치·다항 조합도 불허).
 *
 * "0 초과 즉시 FAIL"(baseline 없음, story #4125/#3758과 같은 급 — 재유입은 발견 즉시
 * 고치는 성질).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
// story #4131 헤더 주석이 역사적 맥락으로 하드코딩 예시를 언급한다(실 사용이 아니라 왜
// 틀렸는지 설명) — globals.css는 스코프 밖(이 파일의 실 선언은 이미 var(--shell-chrome-h)
// 뿐, verify-no-unlayered-css-class.test.ts가 별도로 그 사실을 pin한다).
const EXCLUDE_FILES = new Set(['globals.css']);

// story #4291 — 둘째 형태는 셸 크롬이 아니라 `[ws]/[proj]` 레이아웃이 **실측**해 싣는 일감 탭 띠 높이(WorkTabsFrame · ResizeObserver)다.
// 하드코딩이 아니고(띠가 없으면 0px) 레이아웃 한 곳이 소유 — 그 한 형태만 더 허용한다(3rem · 48px · 다른 변수 조합은 여전히 RED).
const ALLOWED_SUBTRAHENDS = new Set(['var(--shell-chrome-h)', 'var(--shell-chrome-h)-var(--work-tabs-h,0px)']);
// CHANGES-1 실측(페드루 PO, 첫 광역화 시도가 dialog.tsx·dropdown-menu.tsx·bottom-dock.tsx·
// doc-mini-toc.tsx 등 무관한 max-h-[calc(100vh-...)](모달/드롭다운/TOC가 뷰포트를 안 넘치게
// 하는, 셸 크롬과 무관한 기존 패턴)까지 전부 잡아버렸다 — 전수 실측: 그 오탐들은 전부
// `max-h-[calc(...)]`이고, 셸 앵커는 전부 `h-[calc(...)]`(bare height, max- 아님)였다. 이
// 구분이 우연이 아니다 — 「뷰포트를 안 넘치게(상한)」와 「셸 크롬 뺀 나머지를 정확히 채우기
// (앵커)」는 서로 다른 의도라 실제로 다른 유틸리티를 쓴다. `h-[calc(...)]` 바로 앞이
// `max-`/`min-`(word char·hyphen)로 안 끝나야만(음의 lookbehind) 매치 — `2xl:h-[...]`류
// 접두 variant는 계속 잡는다(":" 뒤는 lookbehind를 안 막음).
const VH_CALC_START_RE = /(?<![-\w])h-\[calc\(\s*100(?:svh|dvh|lvh|vh)\s*-\s*/g;

export interface HardcodedAnchorHit {
  file: string;
  line: number;
  found: string;
}

/** matchEnd(= "calc(100Xvh - " 바로 뒤)부터 괄호 깊이를 세어 이 calc()의 진짜 닫는 괄호까지
 * 뺄셈 표현식 원문을 뽑는다. 단순 `[^)]+` 정규식은 `var(--shell-chrome-h)` 자체가 내부에
 * `)`를 포함해 조기 종료되므로(잘못된 부분 캡처) 반드시 depth-tracking이 필요하다. */
function extractSubtrahend(line: string, matchEnd: number): string | null {
  let depth = 1; // 이미 바깥 calc( 안에 있음
  let buf = '';
  for (let i = matchEnd; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return buf.trim();
    }
    buf += ch;
  }
  return null; // 괄호가 안 닫힘(파일 스캔 중 줄바꿈에 걸침 등) — 이 줄만으론 완전한 판정 불가, 스킵.
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
      VH_CALC_START_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = VH_CALC_START_RE.exec(line)) !== null) {
        const subtrahend = extractSubtrahend(line, m.index + m[0].length);
        if (subtrahend !== null && !ALLOWED_SUBTRAHENDS.has(subtrahend)) {
          // 리포트 문구는 매치 정규식의 "h-[" 앵커 프리픽스를 뺀 순수 calc(...) 표현만
          // (앵커 판별용 lookbehind 매치와 사람이 읽을 진단 문자열은 다른 관심사).
          const calcOnly = m[0].replace(/^h-\[/, '');
          hits.push({ file: path.relative(srcRoot, file), line: i + 1, found: `${calcOnly}${subtrahend})` });
        }
      }
    });
  }
  return hits;
}

function main(): number {
  const hits = findHardcodedShellChromeAnchors(SRC_ROOT);
  if (hits.length > 0) {
    console.error('FAIL: 뷰포트 높이 앵커에서 --shell-chrome-h 이외의 값을 직접 빼는 자리 발견(story #4131 회귀):');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.found}`);
    console.error(
      '\nTopBar 표시 여부·모바일 탭바를 반영 못 하는 하드코딩(3rem·48px·var(--mobile-tab-bar-h) 직접 참조·' +
        '다항 조합 등) 대신 h-[calc(100svh-var(--shell-chrome-h))]만 쓴다(globals.css --shell-chrome-h SSOT).',
    );
    return 1;
  }
  console.log('OK: 뷰포트 높이 앵커 하드코딩 0건(허용은 var(--shell-chrome-h) · 그 뒤 레이아웃 실측 var(--work-tabs-h,0px) 한 형태).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
