/**
 * story #3592(유나 §22-18 정본, 페드루 PO 確定 2026-09-06~07) — 「목록 항목마다 같은
 * 접근 이름을 갖는 행 액션 버튼」 재발 가드("유나의 자"). comments-section.tsx에서
 * 「답변」·「작업으로 전환」이 댓글마다 같은 접근 이름을 갖던 결함(§17-20 ⑧과 같은
 * 클래스)이 전수 스윕 없이 남아 있다가 유나 배포 44 회차 실측으로 드러났다 — 이 가드는
 * 그 클래스가 다시 새는 것을 막는다.
 *
 * ## 알고리즘(스토리 본문 AC3 그대로)
 * `.map(` 호출을 찾아 괄호 균형으로 콜백 전체(화살표 함수 본문)의 범위를 잡은 뒤, 그
 * 범위 안의 `<button`/`<Button` 요소마다: (a) 여는 태그 속성에 `aria-label=`이 있으면
 * 건너뛴다(있는지 없는지만 본다 — 값이 진짜 항목별로 갈리는지는 §22-18 ⛔선언대로 이
 * 가드의 관할 밖, 아래 참고), (b) 자식(보이는 라벨) 텍스트가 그 `.map()`의 루프
 * 변수를 참조하면(이미 항목별로 다른 텍스트라 스스로 갈린다) 건너뛴다, (c) 그 외
 * (=정적 라벨+aria-label 없음)는 히트로 센다.
 *
 * ## ⚠️이 가드가 «못 잡는» 것(과잉 확장 방지, 선언 없이 초록이면 「전부 봤다」로 읽힌다)
 *   ㉠ **aria-label이 있지만 정적 값인 경우**(예: `aria-label={t('unlinkAria')}`를
 *      항목별 인자 없이 그대로 쓰는 것) — AC11이 정확히 경고하는 함정("aria-label
 *      있는가"로 세면 놓친다). 이 가드는 "있다/없다"만 보고 그 값의 «품음 여부»는
 *      안 잰다(pr-link-section.tsx:208의 실사례). 검산은 반드시 이 가드가 아니라
 *      comments-action-aria-labels.test.ts류의 부분 문자열 테스트로 한다.
 *   ㉡ `<button>`/`<Button>`이 아닌 클릭 가능 요소(`<a>`·`role="button"` div 등)는
 *      대상 밖 — 리터럴 태그명만 본다(verify-no-new-raw-button.ts와 동형 관례).
 *   ㉢ `aria-labelledby`로 다른 요소를 가리켜 이름을 얻는 패턴은 대상 밖(aria-label
 *      속성 존재 여부만 봄 — labelledby도 "있다"로는 안 잡히니 오탐 방향은 안전).
 *   ㉣ 루프 변수 참조 판정은 자식 텍스트에 그 식별자가 «어디든» 나타나는지만 보는
 *      단순 정규식이다 — 실제로 화면에 보이는 텍스트가 아니라 주석·다른 속성
 *      틈에 우연히 같은 이름이 있어도 "동적"으로 오판(false negative)할 수 있다.
 *   ㉤ 중첩 `.map()`(map 안에 map)은 바깥쪽 루프 변수까지는 못 본다 — 안쪽 콜백
 *      파라미터만 "그 루프의 변수"로 취급한다.
 *   ㉥ destructuring 파라미터(`.map(([a, b]) => ...)`)는 루프 변수명을 못 뽑아
 *      모든 정적 라벨 버튼을 무조건 히트로 센다(과소 신뢰보다 과다 플래그가 안전 —
 *      "결함 목록이 아니라 열어 볼 목록"이므로).
 *
 * baseline-freeze 관례(verify-no-new-raw-button.ts와 동형, 신규 발명 금지) — 지금
 * grandfathered 채무(comments-section.tsx는 #3953 착지 뒤 별도 배선 대기·
 * workflow-trigger-types-section.tsx의 편집/삭제/확認/취소 4곳은 이 스토리 스코프
 * 밖으로 명시 보류, PR 본문 §22-18 판정표 참고)는 baseline에 얼리고, baseline
 * 초과(=신규 증가)만 막는다. 「전부 깨끗」이 아니라 「안 늘었다」가 이 가드의 약속.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;

const MAP_CALL_RE = /\.map\(\s*\(\s*([a-zA-Z_$][\w$]*)?/g;
const BUTTON_OPEN_RE = /<(button|Button)(?=[\s/>])/g;

/** content[openIndex]가 openChar일 때, 균형 잡힌 닫는 위치(포함)까지의 인덱스. 못 찾으면 -1. */
function findBalancedEnd(content: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i += 1) {
    const c = content[i];
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `<button`/`<Button` 매치 시작점에서 그 여는 태그의 끝(`>`  또는 `/>`)까지. 속성 안
 * `{}` JSX 표현식 내부의 `>`(예: 제네릭·비교 연산자)는 건너뛴다. */
function findOpenTagEnd(content: string, tagStart: number): number {
  let braceDepth = 0;
  for (let i = tagStart; i < content.length; i += 1) {
    const c = content[i];
    if (c === '{') braceDepth += 1;
    else if (c === '}') braceDepth -= 1;
    else if (c === '>' && braceDepth === 0) return i;
  }
  return -1;
}

export interface RepeatedRowActionHit {
  file: string;
  line: number;
  snippet: string;
}

/** 파일 내용 하나에서 히트 목록(줄 번호는 1-based, 여는 태그 시작 기준). */
export function findRepeatedRowActionHits(content: string): { line: number; snippet: string }[] {
  const hits: { line: number; snippet: string }[] = [];
  const lineStarts = computeLineStarts(content);

  MAP_CALL_RE.lastIndex = 0;
  let mapMatch: RegExpExecArray | null;
  while ((mapMatch = MAP_CALL_RE.exec(content)) !== null) {
    const loopVar = mapMatch[1] ?? null; // null=destructuring 등, ㉥ 참고.
    // `.map(` 바로 뒤 `(`부터 괄호 균형으로 map() 호출 전체 범위를 잡는다.
    const mapArgsOpen = content.indexOf('(', mapMatch.index + mapMatch[0].indexOf('.map') + 4);
    if (mapArgsOpen === -1) continue;
    const mapArgsClose = findBalancedEnd(content, mapArgsOpen, '(', ')');
    if (mapArgsClose === -1) continue;
    const blockStart = mapArgsOpen;
    const blockEnd = mapArgsClose;
    const block = content.slice(blockStart, blockEnd);
    if (!/<(button|Button)[\s/>]/.test(block)) continue; // 빠른 bail — 버튼 자체가 없음.

    BUTTON_OPEN_RE.lastIndex = 0;
    let btnMatch: RegExpExecArray | null;
    while ((btnMatch = BUTTON_OPEN_RE.exec(block)) !== null) {
      const tagName = btnMatch[1]!;
      const absTagStart = blockStart + btnMatch.index;
      const relTagStart = btnMatch.index;
      const relTagEnd = findOpenTagEnd(block, relTagStart);
      if (relTagEnd === -1) continue;
      const openTagText = block.slice(relTagStart, relTagEnd + 1);
      const selfClosing = openTagText.trimEnd().endsWith('/>');
      if (openTagText.includes('aria-label')) continue; // ㉠ — 있다/없다만 봄.

      if (!selfClosing) {
        const closeTagPattern = `</${tagName}>`;
        const closeIdx = block.indexOf(closeTagPattern, relTagEnd + 1);
        if (closeIdx !== -1) {
          const childrenText = block.slice(relTagEnd + 1, closeIdx);
          // 루프 변수의 «필드를 그대로 보간»하는 경우만 "이미 항목별로 갈린다"로
          // 본다(예: `{item.name}`) — 조건식·비교 안에서 루프 변수를 «참조만» 하는
          // 것(예: `comment.repliesCount > 0 ? A : B`, 이 스토리의 실제 처방 대상
          // 이었던 답변/답변더하기 스위치)은 여전히 두 항목이 같은 상태면 같은
          // 텍스트를 내므로 "갈린다"가 아니다 — 자기 자신의 실측 함정을 self-test
          // 도입 中 발견해 좁혔다(느슨한 `\b${loopVar}\b` identifier-anywhere
          // 검사는 이 실제 사례를 false negative로 놓쳤다).
          const bareFieldInterpolation = loopVar
            ? new RegExp(`\\{\\s*${loopVar}\\.[\\w$]+(?:\\.[\\w$]+)*\\s*\\}`)
            : null;
          if (bareFieldInterpolation?.test(childrenText)) {
            continue;
          }
        }
      }
      // 정적 라벨(또는 판정 불가 destructuring) + aria-label 없음 → 히트.
      const line = lineNumberFor(lineStarts, absTagStart);
      const snippet = content.slice(absTagStart, Math.min(absTagStart + 80, content.length)).split('\n')[0]!.trim();
      hits.push({ line, snippet });
    }
  }
  return hits;
}

function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineNumberFor(lineStarts: number[], index: number): number {
  // 이진 탐색 없이 선형 — 파일당 1회 스캔이라 스크립트 규모에서 무리 없음(다른 verify-*
  // 스크립트와 동형 단순성 유지).
  let line = 1;
  for (let i = 1; i < lineStarts.length; i += 1) {
    if (lineStarts[i]! > index) break;
    line = i + 1;
  }
  return line;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

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
    const hits = findRepeatedRowActionHits(content);
    if (hits.length > 0) counts.set(rel, hits.length);
  }
  return counts;
}

const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'repeated-row-action-names-baseline.json');

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

export function computeOverages(counts: Map<string, number>, baseline: Map<string, number>): Overage[] {
  const overages: Overage[] = [];
  for (const [file, count] of counts) {
    const allowed = baseline.get(file) ?? 0;
    if (count > allowed) overages.push({ file, count, allowed });
  }
  return overages;
}

// AC5 — 유나 아티팩트 856d868c 반영: 자체 대조(양방향)가 실패하면 exit 2로 스윕 결과
// 자체를 믿지 않는다. 처방 前 comments-section.tsx는 2건(commentsConvertToTaskCta·
// commentsReplyCta 둘 다 aria-label 0)을, 처방 후(두 버튼에 aria-label 삽입) 사본은
// 0건을 내야 한다. 라이브 파일이 아니라 고정 픽스처 문자열로 검증한다 — 이 스토리의
// comments-section.tsx 실배선 시점과 무관하게 self-test 자체는 항상 같은 값을 내야
// 하기 때문(라이브 파일에 의존하면 다른 PR이 그 파일을 고치는 순간 self-test가
// 조용히 의미를 잃는다).
const SELFTEST_BEFORE_FIXTURE = `
export function CommentsList({ comments, t, onConvertToTask, onReply }: Props) {
  return (
    <ul>
      {comments.map((comment) => (
        <li key={comment.id}>
          <Button onClick={() => onConvertToTask(comment)} data-testid="comments-item-convert-to-task">
            {t('commentsConvertToTaskCta')}
          </Button>
          <Button onClick={() => onReply(comment)} data-testid="comments-item-reply">
            {comment.repliesCount > 0 ? t('commentsReplyAgainCta') : t('commentsReplyCta')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
`;

const SELFTEST_AFTER_FIXTURE = `
export function CommentsList({ comments, t, onConvertToTask, onReply }: Props) {
  return (
    <ul>
      {comments.map((comment, index) => (
        <li key={comment.id}>
          <Button
            onClick={() => onConvertToTask(comment)}
            data-testid="comments-item-convert-to-task"
            aria-label={t('commentsConvertToTaskAriaLabel', { n: index + 1, label: t('commentsConvertToTaskCta') })}
          >
            {t('commentsConvertToTaskCta')}
          </Button>
          <Button
            onClick={() => onReply(comment)}
            data-testid="comments-item-reply"
            aria-label={t('commentsReplyAriaLabel', { n: index + 1, label: comment.repliesCount > 0 ? t('commentsReplyAgainCta') : t('commentsReplyCta') })}
          >
            {comment.repliesCount > 0 ? t('commentsReplyAgainCta') : t('commentsReplyCta')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
`;

export function runSelfTest(): boolean {
  const before = findRepeatedRowActionHits(SELFTEST_BEFORE_FIXTURE).length;
  const after = findRepeatedRowActionHits(SELFTEST_AFTER_FIXTURE).length;
  const ok = before === 2 && after === 0;
  console.log(`[self-test] 처방 前 픽스처 히트=${before}(기대 2) · 처방 後 픽스처 히트=${after}(기대 0) — ${ok ? 'OK' : 'FAIL'}`);
  return ok;
}

function main(): number {
  if (process.argv.includes('--selftest')) {
    const ok = runSelfTest();
    if (!ok) {
      console.error('\nFAIL: self-test 자체 대조 실패 — 아래 실제 스윕 결과를 믿지 않는다(가드 로직이 깨졌을 가능성).');
      return 2;
    }
  }

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
    `[유나의 자] 행마다 반복되는 정적 라벨 버튼(aria-label 0) 스캔 — ${counts.size}개 파일/${totalOcc}건 · ` +
      `baseline(grandfather) ${baseline.size}개 파일 — 이 목록은 결함 목록이 아니라 «열어 볼 목록»이다(㉠~㉥ 블라인드 스팟 참고, 스크립트 머리 주석).`,
  );

  const overages = computeOverages(counts, baseline);

  const staleBaseline = [...baseline.keys()].filter((f) => !counts.has(f));
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ baseline에 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는) 파일: ${staleBaseline.length}개`);
  }

  if (overages.length > 0) {
    console.error('\nFAIL: baseline을 초과한 반복 행 액션 정적 라벨 발견(story #3592 회귀 — §22-18 그대로 aria-label에 순번+현재 라벨을 품길):');
    for (const o of overages.sort((a, b) => a.file.localeCompare(b.file))) {
      console.error(`  - ${o.file}: ${o.count}건(허용 ${o.allowed}건)`);
    }
    console.error('\n→ aria-label={t(\'xxxAriaLabel\', { n: index + 1, label: <현재 보이는 라벨> })}로 순번을 품기거나, 행 액션이 아니면(단일·이미 항목별로 갈림) baseline 갱신은 PO 승인 뒤.');
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
        'story #3592(§22-18) grandfather baseline — 이 가드 첫 도입 시점 develop의 기존',
        '반복 행 액션 정적 라벨(aria-label 없음). 이 가드는 "더 늘지 않는다"만 보장한다',
        '(freeze, 개별 수리는 PO 판단 대상 — 판정표에서 「행 액션 아님/단일」로 가른',
        '후보는 애초에 이 baseline에 안 실린다, 스캔 자체가 정적 라벨+aria-label 부재만 셈).',
      ],
      counts: sorted,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
