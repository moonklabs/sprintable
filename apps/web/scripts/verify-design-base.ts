/**
 * story 4831 AC4 — 「바탕 한 벌」 0 유지 가드.
 *
 * 화면 묶음(첫 실행 길 · 대화 · 보드 · 승인 · 에이전트 · 문서·목표 · 브리핑 · 공용 부품)과 바탕 부품 폴더
 * (components/ui · components/design-system)의 소스에서 «바탕을 거치지 않은 값»이 한 건도 없어야 통과한다.
 *
 * 세는 값(OFF_KINDS): 색 리터럴(#hex) · 색 함수(rgb · hsl · oklch · color-mix 등, 인자가 전부 var()인 color-mix는 제외) ·
 * Tailwind 기본 팔레트 클래스 · bg/text-white|black · 임의 글자 크기 text-[13px] · fontSize 인라인 · 정한 눈금 10단 밖의 글자 단 ·
 * 임의 간격 p-[7px] · padding/margin/gap 인라인 · 임의 모서리 rounded-[5px] · borderRadius 인라인.
 * 주석은 먼저 지운다(주석 속 «#3127» 같은 이슈 번호를 색으로 세지 않으려고). 시험 · 가드 · stories 파일은 뺀다.
 *
 * 또 하나의 종류 — 날것 입력칸(`raw_control`): 부품(Input · Textarea · Select · Checkbox · RadioGroup) 대신 쓴 날 `<input>` · `<textarea>` · `<select>`.
 * 이 종류는 «닫힌 묶음»(`Group.closed`)에서만 센다 — 묶음의 부품 교체가 끝난 뒤 0으로 못 박는 것이다(아직 교체 중인 묶음은 닫지 않는다).
 * 아홉 묶음 모두 닫혔다(첫 실행 길 · 대화 · 보드 · 승인 · 에이전트 · 문서·목표 · 브리핑 · 공용 부품 · 바탕 부품).
 * 바탕 부품의 `ui/select` · `ui/textarea`는 부품 «정의 자신»이라 쓰는 날 태그를 명단에 올린다.
 * 정규식이 아니라 TypeScript 구문 트리로 본다: 문자열 · 주석 속 `<input>`(예: HTML 문자열을 만드는 변환기)은 세지 않는다.
 * 한계: 세는 것은 JSX 소스의 소문자 태그뿐이다 — `document.createElement('input')` · `React.createElement('input')`처럼 실행 중에 만드는 입력칸은 못 본다
 * (지금은 둘이다: 문서 슬래시 명령의 파일 고르기 입력(`type=file`, 화면에 그려지지 않고 파일 대화상자만 연다)과 복사 대체 경로의 임시 `textarea`(`lib/clipboard.ts`,
 * 눌러 복사한 뒤 바로 지운다) — 둘 다 사람이 쓰는 칸으로 그려지지 않아 이 가드의 범위 밖으로 둔다. 새 런타임 생성 칸이 사람이 쓰는 칸이면 이 한계 때문에 가드가 못 본다).
 * 부품으로 바꾸지 않는 입력(파일 선택 · 숨은 값) · 편집기 표면은 명단에 `kinds: ['raw_control']` + `count`(그 파일의 정확한 개수) + `why`로 올린다 —
 * 개수가 실제와 다르면(새로 늘었거나 낡았거나) 실패.
 *
 * 또 하나의 종류 — 덮개(`overlay`): 손으로 지은 덮개 층(전체 화면 가림막 클래스 `fixed inset-0` 또는 손으로 쓴 `role="dialog"` — 입력창 안 콤보박스처럼 전체 화면이 아니어도 대화상자 역할을 손으로 쓰면 센다). 구문 트리로 `fixed`와 `inset-0` 클래스 토큰이 함께 든 문자열과 손으로 쓴 JSX `role="dialog"`를 센다
 * (묶음 안에서는 처음 재던 4816 인벤토리의 정규식 셈과 같은 수라 숫자가 이어진다 · 주석 속 언급과 `inset-0.5` 같은 비슷한 클래스는 안 센다).
 * 이것도 닫힌 묶음에서만 센다. 바탕 부품(Dialog · Sheet · Popover)으로 못 옮기는 덮개는 명단에 `kinds: ['overlay']` + `count`(그 파일의 정확한 표시 수) + `why` +
 * `lockedBy`(그 현재 동작을 잠그는 시험 — `시험 파일::시험 제목`, 파일은 src 기준 경로)로 올린다. 가드는 인용한 시험이 «실제로 있는지»까지 본다: 파일이 있고, 제목이
 * `it(…)` · `test(…)`의 문자열 첫 인자로 있으며, `skip` · `todo` 아래가 아니어야 한다 — 시험이 지워지거나 이름이 바뀌거나 꺼지면 CI가 빨개진다(까닭만 남고 잠금이 사라지는 것을 막는다).
 *
 * 묶음 «밖»(AC의 아홉 묶음에 안 든 파일)의 덮개는 기준선으로 고정한다: 같은 구문 트리 셈을 소스 전체에 돌려 `outsideOverlayBaseline`(파일 → 표시 수)보다 늘면 실패,
 * 줄면 허용하고 기준선을 내리라고 알린다(raw-button 기준선 가드와 같은 결). 지금은 `components/storage/storage-view.tsx` 한 파일(4표시)이 알려진 채무다.
 *
 * 예외 명단 `design-base-exceptions.json`은 «바탕이 정할 수 없는 값»(제3자 브랜드색 · 사용자 데이터 색 · 라이브러리 입력 등)을 담고, 날것 입력칸(`raw_control`)과 덮개(`overlay`)는
 * «부품으로 못 바꾸는 까닭»을 담는다(덮개는 현재 동작을 잠그는 시험까지).
 *   - 항목마다 `why`(까닭) 필수 — 비어 있거나 짧으면 실패.
 *   - 명단이 가리키는 파일이 묶음 안에 없거나, 적은 종류가 그 파일에서 0건이면 실패(낡은 항목은 걷는다).
 *   - 도구가 값을 오인하는 경우는 명단이 아니라 이 스캐너를 고친다(워크셀의 토큰만 섞는 color-mix가 그 예).
 * 묶음 경로가 사라지거나 비면 실패(폴더 이동으로 가드가 헛도는 것을 막는다).
 *
 * 한계: 값이 토큰과 같은 hex여도 직접 쓴 것은 센다(토큰을 «거쳤나»를 본다, 값이 맞는지는 따로).
 * 색 · 글자 · 간격 스캐너는 정규식 기반 정적 상한이라 `cn()`이 조합한 클래스 이름이나 변수로 만든 문자열 값은 못 본다(날것 입력칸과 덮개는 구문 트리로 센다 — 그 한계는 각 항목에).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// ---- 값의 종류 ----
export const OFF_KINDS = [
  'color_literal',
  'color_fn',
  'color_palette',
  'color_bw',
  'font_arb',
  'font_inline',
  'font_off_scale',
  'space_arb',
  'space_inline',
  'radius_arb',
  'radius_inline',
] as const;
export type OffKind = (typeof OFF_KINDS)[number];
export type Hit = readonly [line: number, snippet: string];
export type Hits = Partial<Record<OffKind, Hit[]>>;

// ---- 묶음 (src 기준 상대 경로 접두사: 폴더 또는 파일) ----
export interface Group {
  name: string;
  prefixes: string[];
  /** 부품 교체가 끝나 날것 입력칸을 0(명단 개수만큼)으로 못 박은 묶음. 아직 교체 중인 묶음은 켜지 않는다. */
  closed?: boolean;
}

export const GROUPS: Group[] = [
  {
    name: '첫 실행 길 (로그인·가입·메일 인증·온보딩·desktop setup)', closed: true,
    prefixes: [
      'app/login', 'app/register', 'app/verify-email', 'app/forgot-password', 'app/reset-password', 'app/set-password',
      'app/mfa', 'app/invite', 'app/onboarding', 'app/desktop', 'app/auth', 'app/phone-start', 'app/phone-landing',
      'app/(authenticated)/desktop', 'components/auth', 'components/desktop', 'components/verify',
    ],
  },
  { name: '대화 (chats)', closed: true, prefixes: ['app/(authenticated)/chats', 'components/chat', 'components/chat-v3'] },
  {
    name: '보드 (flow·sprints)', closed: true,
    prefixes: ['app/(authenticated)/[ws]/[proj]/flow', 'app/(authenticated)/[ws]/[proj]/sprints', 'components/flow', 'components/sprints', 'components/kanban'],
  },
  { name: '승인 (gates)', closed: true, prefixes: ['app/(authenticated)/gates', 'app/(authenticated)/inbox', 'components/inbox', 'components/cage'] },
  { name: '에이전트 (organization/workforce)', closed: true, prefixes: ['app/(authenticated)/organization/workforce', 'components/agents'] },
  {
    name: '문서·목표', closed: true,
    prefixes: ['app/(authenticated)/[ws]/[proj]/docs', 'app/(authenticated)/[ws]/[proj]/goals', 'app/(authenticated)/docs', 'components/docs', 'components/goals'],
  },
  { name: '브리핑 (org-briefing)', closed: true, prefixes: ['app/(authenticated)/org-briefing', 'components/org-briefing'] },
  {
    name: '공용 부품 (화면이 부르는 공용 폴더)',
    closed: true,
    prefixes: [
      'components/canvas', 'components/nav', 'components/workcell', 'components/proof-capsule', 'components/shared', 'components/integrations',
      'components/epics', 'components/hypotheses', 'components/ai', 'components/attention-queue', 'components/command-palette', 'components/outcome',
      'components/support-widget', 'components/glance', 'components/brand', 'components/dispatch', 'components/insights-board', 'components/presence',
      'components/content', 'components/dashboard', 'components/legal', 'components/release-notes', 'components/standup', 'components/workspace', 'components/providers',
      'app/(authenticated)/layout.tsx', 'app/(authenticated)/error.tsx', 'app/(authenticated)/not-found.tsx',
      'lib/channel-label.ts', 'lib/runtime-capabilities.ts', 'services/canvas.ts',
    ],
  },
  { name: '바탕 부품 (components/ui + design-system)', closed: true, prefixes: ['components/ui', 'components/design-system'] },
];

// 묶음 합이 이보다 적으면 가드가 헛도는 것(폴더 이동 · 경로 오타)이다. 지금 약 545파일.
export const MIN_EXPECTED_FILES = 450;
const MIN_WHY_LENGTH = 10;

const SKIP_FILE = /(\.test\.|\.spec\.|\.guard\.|\.stories\.|\/__tests__\/|\.d\.ts$)/;
const EXT = /\.(?:ts|tsx)$/;

// ---- 정규식 ----
const HEX_DIGITS = '(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})';
const RE_HEX = new RegExp(`(?<![\\w&\\/#"'=-])#${HEX_DIGITS}\\b(?![\\w-])`, 'g');
// 따옴표 안의 «#fff»는 위 lookbehind가 따옴표를 빼므로 별도 식으로 따옴표 · 괄호 · 공백 · 쉼표 바로 뒤를 허용한다.
const RE_HEX_Q = new RegExp(`["'\`(\\[ :,]#${HEX_DIGITS}(?![\\w-])`, 'g');
const RE_HEX_ANCHOR_CONTEXT = /(?:href|to|id|htmlFor|aria-[a-z]+|data-[a-z-]+|name)=\{?\s*["'`]?$/;
// «_rgba(» 처럼 밑줄 뒤에 붙은 Tailwind 임의 값(shadow-[0_16px_46px_rgba(…)])도 잡도록 «앞이 영문자가 아님»으로 본다.
const RE_COLORFN = /(?<![A-Za-z])(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\(/gi;
const PALETTE = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)';
const UTIL_C = '(?:bg|text|border|ring|ring-offset|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|shadow|placeholder|border-[xytblrse])';
const RE_PALETTE = new RegExp(`(?<![\\w-])(?:[a-z0-9-]+:)*${UTIL_C}-${PALETTE}-(?:50|100|200|300|400|500|600|700|800|900|950)(?:/\\d+)?(?![\\w-])`, 'g');
const RE_BW = /(?<![\w-])(?:[a-z0-9-]+:)*(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration)-(?:white|black)(?:\/\d+)?(?![\w-])/g;

const SIZES = '(?:micro|display|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|editorial-[a-z]+)';
// 규격 v1 §1 — 정한 글자 눈금 10단. 이 밖의 눈금 이름(3xl 이상 · editorial-body · editorial-claim)은 «눈금 밖».
export const ALLOWED_STEPS: ReadonlySet<string> = new Set(['micro', 'editorial-meta', 'xs', 'editorial-ui', 'sm', 'base', 'lg', 'xl', '2xl', 'display']);
const RE_TEXT_SCALE = new RegExp(`(?<![\\w-])(?:[a-z0-9-]+:)*text-(${SIZES})(?![\\w-])`, 'g');
const RE_TEXT_ARB = /(?<![\w-])(?:[a-z0-9-]+:)*text-\[\s*(?:length:\s*)?(-?\d+(?:\.\d+)?)(px|rem|em)\s*\]/g;
const RE_TEXT_ARB_FN = /(?<![\w-])(?:[a-z0-9-]+:)*text-\[\s*(?:length:\s*)?(?:calc|clamp|min|max)\(/g;
const RE_FONTSIZE_INLINE = /\bfont-?[sS]ize\s*:\s*['"]?(-?\d+(?:\.\d+)?)(px|rem|em)?/g;

const SP = '(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|left|right|bottom|start|end)';
const RE_SPACE_ARB = new RegExp(`(?<![\\w-])(?:[a-z0-9-]+:)*-?${SP}-\\[\\s*-?\\d+(?:\\.\\d+)?(?:px|rem|em)\\s*\\]`, 'g');
const RE_SPACE_INLINE = /\b(?:padding|margin|gap|rowGap|columnGap)(?:Top|Bottom|Left|Right|Inline|Block|Horizontal|Vertical)?\s*:\s*['"]?-?\d+(?:\.\d+)?(?:px|rem|em)?/g;

const RE_RADIUS_ARB = /(?<![\w-])(?:[a-z0-9-]+:)*rounded(?:-[a-z]{1,2})?-\[\s*[\d.]+(?:px|rem|em|%)\s*\]/g;
const RE_RADIUS_INLINE = /\bborder(?:[A-Z][a-z]+)?Radius\s*:\s*['"]?\d+(?:\.\d+)?/g;

// ---- 주석 지우기 ----
/** 줄 앞부분(prefix)이 끝난 자리가 따옴표 문자열(' " `) 안이면 true — 거기 나온 `//`는 주석이 아니라 문자열의 글자다. */
function endsInsideString(prefix: string): boolean {
  let quote = '';
  for (let k = 0; k < prefix.length; k += 1) {
    const ch = prefix[k];
    if (quote) {
      if (ch === '\\') k += 1;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    }
  }
  return quote !== '';
}

/**
 * 주석을 지운다(줄 수는 지키려고 줄바꿈은 남긴다). 시작 표지 앞 글자로 거른다:
 * `//`는 앞이 공백 · ; { } , ( ) [ ] = > 일 때만(URL의 `://`는 앞이 `:`라 빠진다),
 * `/*`는 앞이 공백 · ; { } , ( = > 일 때만(경로 글 `src/** /*.ts`는 앞이 글자 · `*`라 빠진다).
 * 거기에 더해 그 줄의 앞부분이 따옴표 문자열 안에서 끝나면 주석이 아니다(`"a // text-[13px]"`의 뒤 클래스를 지우지 않는다).
 * 반대 방향의 오판 — JSX 글 속 아포스트로피(don't)나 정규식 리터럴의 따옴표 뒤에 같은 줄 주석이 오는 경우 — 은 그 주석을
 * 지우지 못해 값을 «더 세는» 쪽(실패 쪽)으로만 틀린다. 여러 줄 템플릿 리터럴 안의 «줄 전체가 // 로 시작하는 줄»은 못 가린다(한계).
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  const n = src.length;
  const ws = ' \t\n';
  const insideString = (at: number): boolean => endsInsideString(src.slice(src.lastIndexOf('\n', at - 1) + 1, at));
  let i = 0;
  while (i < n) {
    const c = src[i];
    const nxt = i + 1 < n ? src[i + 1] : '';
    const prev = i ? src[i - 1] : '\n';
    if (c === '/' && nxt === '*' && (ws + ';{},(=>').includes(prev) && !insideString(i)) {
      const k = src.indexOf('*/', i + 2);
      const j = k < 0 ? n : k + 2;
      out.push(src.slice(i, j).replace(/[^\n]/g, ' '));
      i = j;
      continue;
    }
    if (c === '/' && nxt === '/' && (i === 0 || (ws + ';{},()[]=>').includes(prev)) && !insideString(i)) {
      const k = src.indexOf('\n', i);
      const j = k < 0 ? n : k;
      out.push(' '.repeat(j - i));
      i = j;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

// ---- color-mix 인자가 전부 토큰이면 이미 바탕을 거친 값 ----
const RE_MIX_SPACE = /^in\s+[a-z0-9-]+(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?$/i;
const RE_MIX_PART = /^(?:\d+(?:\.\d+)?%\s*)?var\(\s*--[\w-]+\s*\)(?:\s*\d+(?:\.\d+)?%)?$/;

/**
 * `color-mix( … )`의 색 인자가 전부 `var(…)` 토큰이면 true. 괄호 짝을 따라 인자 목록을 얻고 괄호 밖 쉼표로 쪼갠다.
 * 첫 조각 «in oklch» 같은 보간 공간 표기는 색이 아니다. 하나라도 리터럴 색(#hex · rgb() · 이름)이면 false.
 */
export function isTokensOnlyColorMix(text: string, matchText: string, matchEnd: number): boolean {
  if (!matchText.toLowerCase().startsWith('color-mix')) return false;
  const n = text.length;
  let i = matchEnd;
  let depth = 1;
  while (i < n && depth) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    i += 1;
  }
  if (depth) return false;
  const inner = text.slice(matchEnd, i - 1);
  const parts: string[] = [];
  let cur = '';
  let d = 0;
  for (const ch of inner) {
    if (ch === '(') d += 1;
    else if (ch === ')') d -= 1;
    if (ch === ',' && d === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  const colors = parts.length && RE_MIX_SPACE.test(parts[0]) ? parts.slice(1) : parts;
  return colors.length >= 2 && colors.every((p) => RE_MIX_PART.test(p));
}

// ---- 한 파일 스캔 (text = 주석을 지운 뒤의 글) ----
export function scanText(text: string): Hits {
  const m: Hits = {};
  const push = (k: OffKind, line: number, snippet: string): void => {
    (m[k] ??= []).push([line, snippet]);
  };
  const addAll = (k: OffKind, rx: RegExp): void => {
    for (const mt of text.matchAll(rx)) push(k, lineOf(text, mt.index ?? 0), mt[0].trim());
  };

  const seen = new Set<string>();
  for (const mt of text.matchAll(RE_HEX)) {
    if (mt[0].length === 5 && /^[0-9]+$/.test(mt[0].slice(1))) continue; // «#NNNN» 숫자만 4자리 = 이슈/PR 번호
    const line = lineOf(text, mt.index ?? 0);
    push('color_literal', line, mt[0]);
    seen.add(`${line}|${mt[0]}`);
  }
  for (const mt of text.matchAll(RE_HEX_Q)) {
    const start = mt.index ?? 0;
    if (RE_HEX_ANCHOR_CONTEXT.test(text.slice(Math.max(0, start - 24), start + 1))) continue; // 링크 앵커 · id 같은 «#이름»은 색이 아니다
    const v = mt[0].slice(1);
    if (v.length === 5 && /^[0-9]+$/.test(v.slice(1))) continue;
    const line = lineOf(text, start);
    const key = `${line}|${v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push('color_literal', line, v);
  }
  for (const mt of text.matchAll(RE_COLORFN)) {
    const end = (mt.index ?? 0) + mt[0].length;
    if (isTokensOnlyColorMix(text, mt[0], end)) continue; // 토큰만 섞는 color-mix는 이미 바탕을 거친 값 — 함수 이름만 보고 세지 않는다
    push('color_fn', lineOf(text, mt.index ?? 0), mt[0].trim());
  }
  addAll('color_palette', RE_PALETTE);
  addAll('color_bw', RE_BW);
  addAll('font_arb', RE_TEXT_ARB);
  addAll('font_arb', RE_TEXT_ARB_FN);
  addAll('font_inline', RE_FONTSIZE_INLINE);
  addAll('space_arb', RE_SPACE_ARB);
  addAll('space_inline', RE_SPACE_INLINE);
  addAll('radius_arb', RE_RADIUS_ARB);
  addAll('radius_inline', RE_RADIUS_INLINE);
  for (const mt of text.matchAll(RE_TEXT_SCALE)) {
    if (!ALLOWED_STEPS.has(mt[1])) push('font_off_scale', lineOf(text, mt.index ?? 0), mt[0].trim());
  }
  return m;
}

// ---- 날것 입력칸 (구문 트리) ----
export const RAW_KIND = 'raw_control';
export const OVERLAY_KIND = 'overlay';
const RAW_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);
export interface RawControl {
  line: number;
  tag: string;
  /** `type="…"`가 문자열 상수일 때만(없거나 식이면 null) */
  type: string | null;
}

/** 소스에서 날 `<input>` · `<textarea>` · `<select>` JSX를 센다(부품 `<Input>` 등 대문자 이름 · 문자열 · 주석 속 마크업은 세지 않는다). */
export function scanRawControls(text: string, file = 'x.tsx'): RawControl[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: RawControl[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && RAW_TAGS.has(node.tagName.text)) {
      const typeAttr = node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'type');
      const init = typeAttr?.initializer;
      out.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        tag: node.tagName.text,
        type: init && ts.isStringLiteral(init) ? init.text : null,
      });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

// ---- 덮개 (손으로 지은 전체 화면 층) ----
export interface OverlayMark {
  line: number;
  mark: 'fixed inset-0' | 'role=dialog';
}

/**
 * 소스에서 손으로 지은 덮개 표시를 센다 — 구문 트리로: ① 한 문자열(템플릿 조각 포함) 안에 클래스 토큰 `fixed`와 `inset-0`이 함께 있는 것
 * ② 손으로 쓴 JSX `role="dialog"` 속성. 주석 속 언급 · `inset-0.5` 같은 비슷한 클래스 · 토큰 순서가 반대인 경우에 흔들리지 않는다.
 * 묶음 안에서는 처음 재던 4816 인벤토리(정규식)와 같은 수를 낸다(서랍을 Sheet로 옮기기 전 16곳 — 측정해 확인했고, 옮긴 뒤 아홉 묶음 안은 14곳). 한계: 변수로 이어 붙이거나 `max-lg:fixed`처럼 접두사가 붙은 토큰, 한 문자열 안에
 * 같이 있지 않은 두 토큰은 못 본다(정적 상한).
 */
export function scanOverlays(text: string, file = 'x.tsx'): OverlayMark[] {
  if (!text.includes('inset-0') && !text.includes('dialog')) return []; // 두 표시 모두 이 글자를 품는다 — 소스 전체를 훑을 때 구문 분석을 아낀다
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<OverlayMark & { pos: number }> = [];
  const lineAt = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const tokens = node.text.split(/\s+/);
      if (tokens.includes('fixed') && tokens.includes('inset-0')) found.push({ pos: node.getStart(sf), line: lineAt(node), mark: 'fixed inset-0' });
    }
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'role' && node.initializer) {
      const init = node.initializer;
      const value = ts.isStringLiteral(init)
        ? init.text
        : ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))
          ? init.expression.text
          : null;
      if (value === 'dialog') found.push({ pos: node.getStart(sf), line: lineAt(node), mark: 'role=dialog' });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found.sort((a, b) => a.pos - b.pos).map(({ line, mark }) => ({ line, mark }));
}

/**
 * 시험 파일에서 «켜져 있는» 시험 제목을 모은다 — `it('…')` · `test('…')`(문자열 · 보간 없는 템플릿 첫 인자). `it.skip` · `it.todo`는 callee가 점 접근이라 모이지 않고,
 * 호출 사슬의 어느 마디에든 `skip` · `todo` · `skipIf` · `runIf`(조건부라 굳은 잠금이 아니다) 또는 `xdescribe` · `xit` · `xtest`가 든 `describe` 아래의 시험도 뺀다
 * (`describe.skip.each(표)('…', …)` · `xdescribe.each(…)(…)` · `describe.skipIf(…)(…)` 포함). 제목은 `describe` 경로 없이 `it`의 제목 그대로다.
 */
export function activeTestTitles(text: string, file = 'x.test.tsx'): Set<string> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const titles = new Set<string>();
  const OFF_NAMES: ReadonlySet<string> = new Set(['skip', 'todo', 'skipIf', 'runIf']);
  // 호출 사슬 전체를 본다: `describe.skip.each(표)('…', fn)`의 바깥 호출은 callee가 호출식이고 `skip`은 그 안쪽 마디에 있다.
  const isOff = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return callee.text === 'xdescribe' || callee.text === 'xit' || callee.text === 'xtest';
    if (ts.isPropertyAccessExpression(callee)) return OFF_NAMES.has(callee.name.text) || isOff(callee.expression);
    if (ts.isCallExpression(callee)) return isOff(callee.expression);
    return false;
  };
  const underOff = (node: ts.Node): boolean => {
    for (let p = node.parent; p; p = p.parent) if (ts.isCallExpression(p) && isOff(p.expression)) return true;
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'it' || node.expression.text === 'test')) {
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && !underOff(node)) titles.add(first.text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return titles;
}

// ---- 소스 읽기 (실제 디스크 / 메모리) ----
export interface SourceReader {
  /** 접두사(폴더 또는 파일) 아래의 파일(src 기준 상대 경로). 접두사 자체가 없으면 null. */
  list(prefix: string): string[] | null;
  read(rel: string): string;
  /** src 전체(시험 · 가드 · stories 제외)의 .ts · .tsx. 없는 판독기는 «묶음 밖 덮개» 검사를 건너뛴다. */
  listAll?(): string[];
}

export function fsReader(srcRoot: string): SourceReader {
  const walk = (dir: string, rel: string, out: string[]): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const r = `${rel}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, r, out);
      else if (EXT.test(entry) && !SKIP_FILE.test(r)) out.push(r);
    }
  };
  const list = (prefix: string): string[] | null => {
    const abs = path.join(srcRoot, prefix);
    if (!existsSync(abs)) return null;
    if (statSync(abs).isFile()) return [prefix];
    const out: string[] = [];
    walk(abs, prefix, out);
    return out;
  };
  return {
    list,
    read: (rel) => readFileSync(path.join(srcRoot, rel), 'utf8'),
    listAll: () => readdirSync(srcRoot).sort().flatMap((entry) => list(entry) ?? []).filter((f) => EXT.test(f) && !SKIP_FILE.test(f)),
  };
}

export function mapReader(files: Record<string, string>): SourceReader {
  const keys = Object.keys(files);
  return {
    list(prefix) {
      const hit = keys.filter((k) => k === prefix || k.startsWith(`${prefix}/`));
      if (!hit.length) return null;
      return hit.filter((k) => k === prefix || (EXT.test(k) && !SKIP_FILE.test(k))).sort();
    },
    read: (rel) => files[rel],
    listAll: () => keys.filter((k) => EXT.test(k) && !SKIP_FILE.test(k)).sort(),
  };
}

// ---- 예외 명단 ----
export interface ExceptionEntry {
  file: string;
  kinds: string[];
  why: string;
  /** `raw_control`을 적을 때 필수 — 그 파일의 날것 입력칸 «정확한» 개수(다르면 실패: 새로 늘었거나 낡았다). */
  count?: number;
  /** `overlay`를 적을 때 필수 — 그 덮개의 현재 동작을 잠그는 시험들(`시험 파일::시험 제목`, 파일은 src 기준). 가드가 실제로 있는지 본다. */
  lockedBy?: string[];
}

export function loadExceptions(filePath: string): ExceptionEntry[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { exceptions?: ExceptionEntry[] };
  return parsed.exceptions ?? [];
}

/** 묶음 «밖» 덮개의 기준선(파일 → 표시 수). 늘면 실패, 줄면 허용(기준선을 내리라고 알린다) — raw-button 기준선 가드와 같은 결. */
export function loadOutsideOverlayBaseline(filePath: string): Record<string, number> {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { outsideOverlayBaseline?: Record<string, number> };
  return parsed.outsideOverlayBaseline ?? {};
}

// 명단의 file은 src 기준 경로 «정확히 일치»만 가린다 — 이름만 같은 다른 폴더의 파일까지 가리지 않는다.
const sameFile = (rel: string, file: string): boolean => rel === file;

// ---- 판정 ----
export interface GroupStat {
  name: string;
  files: number;
  offFiles: number;
}
export interface OffFile {
  file: string;
  count: number;
  samples: string[];
}
export interface Evaluation {
  groups: GroupStat[];
  unionFiles: number;
  offFiles: OffFile[];
  /** 날것 입력칸: 닫힌 묶음의 파일 수 · 찾은 수 · 명단이 허용한 수 */
  rawControls: { closedFiles: number; found: number; allowed: number };
  /** 덮개: 닫힌 묶음의 파일 수 · 찾은 표시 수 · 명단이 허용한 수 · 명단이 인용한 시험 수 */
  overlays: { closedFiles: number; found: number; allowed: number; lockedTests: number };
  /** 묶음 밖 덮개: 소스 전체 파일 수(null이면 판독기가 listAll을 안 줘서 건너뜀) · 묶음 밖에서 찾은 표시 수 · 기준선 합 · 기준선보다 줄어 내릴 수 있는 파일 */
  outsideOverlays: { scannedFiles: number | null; found: number; baseline: number; shrunk: string[] };
  problems: string[];
}

export function evaluate(reader: SourceReader, groups: Group[], exceptions: ExceptionEntry[], outsideOverlayBaseline: Record<string, number> = {}): Evaluation {
  const problems: string[] = [];

  // 1) 묶음 → 파일. 접두사가 없으면, 묶음이 비면 실패.
  const groupFiles = new Map<string, string[]>();
  for (const g of groups) {
    const files = new Set<string>();
    for (const prefix of g.prefixes) {
      const found = reader.list(prefix);
      if (found === null) problems.push(`묶음 «${g.name}»의 경로가 없다: ${prefix} (폴더를 옮겼다면 GROUPS를 같이 고친다)`);
      else found.forEach((f) => files.add(f));
    }
    if (!files.size) problems.push(`묶음 «${g.name}»에 파일이 하나도 없다`);
    groupFiles.set(g.name, [...files].sort());
  }
  const union = [...new Set([...groupFiles.values()].flat())].sort();
  if (union.length < MIN_EXPECTED_FILES) {
    problems.push(`검사 대상이 ${union.length}파일뿐이다(최소 ${MIN_EXPECTED_FILES}) — 가드가 헛돌고 있다`);
  }

  // 2) 명단 형식 · 까닭 · 대상 파일
  const kindSet: ReadonlySet<string> = new Set<string>([...OFF_KINDS, RAW_KIND, OVERLAY_KIND]);
  const matched = new Map<ExceptionEntry, string[]>();
  for (const e of exceptions) {
    const label = `예외 명단 «${e.file}»`;
    if (typeof e.file !== 'string' || !e.file.trim()) {
      problems.push('예외 명단에 file이 빈 항목이 있다');
      continue;
    }
    if (typeof e.why !== 'string' || e.why.trim().length < MIN_WHY_LENGTH) {
      problems.push(`${label}: 까닭(why)이 없거나 너무 짧다(${MIN_WHY_LENGTH}자 이상) — 까닭 없이 올리지 않는다`);
    }
    if (!Array.isArray(e.kinds) || !e.kinds.length) problems.push(`${label}: kinds가 비었다`);
    else for (const k of e.kinds) if (!kindSet.has(k)) problems.push(`${label}: 모르는 종류 «${k}» (${[...OFF_KINDS, RAW_KIND, OVERLAY_KIND].join(' · ')})`);
    const files = union.filter((rel) => sameFile(rel, e.file));
    if (!files.length) problems.push(`${label}: 검사 묶음 안에 그 파일이 없다 — 항목을 걷거나 경로를 고친다`);
    matched.set(e, files);
  }

  // 3) 스캔 (한 파일 한 번)
  const raw = new Map<string, Hits>();
  for (const rel of union) raw.set(rel, scanText(stripComments(reader.read(rel))));

  // 4) 명단 적용 — 적은 종류가 그 파일들에서 0건이면 낡은 항목
  const exempt = new Map<string, Set<string>>();
  for (const [e, files] of matched) {
    for (const k of Array.isArray(e.kinds) ? e.kinds : []) {
      if (!kindSet.has(k) || k === RAW_KIND || k === OVERLAY_KIND) continue; // 날것 입력칸 · 덮개는 아래 6) 7)에서 개수로 따로 본다
      const total = files.reduce((n, rel) => n + (raw.get(rel)?.[k as OffKind]?.length ?? 0), 0);
      if (files.length && total === 0) problems.push(`예외 명단 «${e.file}»: «${k}»가 그 파일에서 0건이다 — 낡은 항목이니 걷는다`);
      for (const rel of files) {
        if (!exempt.has(rel)) exempt.set(rel, new Set());
        exempt.get(rel)!.add(k);
      }
    }
  }

  // 5) 파일별 바탕 밖 값
  const offByFile = new Map<string, OffFile>();
  for (const rel of union) {
    const hits = raw.get(rel)!;
    const skip = exempt.get(rel);
    let count = 0;
    const samples: string[] = [];
    for (const k of OFF_KINDS) {
      if (skip?.has(k)) continue;
      for (const [line, snippet] of hits[k] ?? []) {
        count += 1;
        if (samples.length < 3) samples.push(`${rel}:${line}  ${k}  ${snippet}`);
      }
    }
    if (count) offByFile.set(rel, { file: rel, count, samples });
  }
  const stats: GroupStat[] = groups.map((g) => {
    const files = groupFiles.get(g.name) ?? [];
    return { name: g.name, files: files.length, offFiles: files.filter((f) => offByFile.has(f)).length };
  });
  const offFiles = [...offByFile.values()];
  for (const o of offFiles) problems.push(`바탕 밖 값 ${o.count}건: ${o.samples.join(' | ')}`);

  // 6) 날것 입력칸 — 닫힌 묶음에서는 명단의 개수와 «정확히» 같아야 한다(더 늘면 새 날것, 모자라면 낡은 항목)
  const closedFiles = new Set<string>();
  for (const g of groups) if (g.closed) for (const f of groupFiles.get(g.name) ?? []) closedFiles.add(f);
  const allowedRaw = new Map<string, number>();
  for (const e of exceptions) {
    if (!Array.isArray(e.kinds) || !e.kinds.includes(RAW_KIND) || typeof e.file !== 'string') continue;
    const label = `예외 명단 «${e.file}»`;
    if (!closedFiles.has(e.file)) {
      problems.push(`${label}: «${RAW_KIND}»은 닫힌 묶음(Group.closed)의 파일에만 올린다`);
      continue;
    }
    if (!Number.isInteger(e.count) || (e.count as number) < 1) {
      problems.push(`${label}: «${RAW_KIND}»에는 개수(count, 1 이상 정수)가 필요하다`);
      continue;
    }
    if (allowedRaw.has(e.file)) {
      // 한 파일에 항목이 둘이면 합쳐 맞는 것처럼 보여도 «항목마다 정확히»가 깨진다(어느 까닭이 어느 칸의 것인지 흐려짐) — 한 항목으로 합쳐 count를 적는다
      problems.push(`${label}: «${RAW_KIND}» 항목이 같은 파일에 둘 이상이다 — 한 항목으로 합쳐 count를 적는다`);
      continue;
    }
    allowedRaw.set(e.file, e.count as number);
  }
  let rawFound = 0;
  let rawAllowed = 0;
  for (const rel of [...closedFiles].sort()) {
    const hits = scanRawControls(reader.read(rel), rel);
    const allowed = allowedRaw.get(rel) ?? 0;
    rawFound += hits.length;
    rawAllowed += Math.min(allowed, hits.length);
    const show = (h: RawControl): string => `${rel}:${h.line} <${h.tag}${h.type ? ` type="${h.type}"` : ''}>`;
    if (hits.length > allowed) {
      problems.push(`날것 입력칸 ${hits.length - allowed}건 더(명단 ${allowed}건): ${hits.slice(0, 3).map(show).join(' | ')} — 부품(Input · Textarea · Select · Checkbox · RadioGroup)으로 바꾼다`);
    } else if (hits.length < allowed) {
      problems.push(`예외 명단 «${rel}»: 날것 입력칸이 ${hits.length}건뿐인데 ${allowed}건이라 적혀 있다 — 낡은 항목이니 개수를 고치거나 걷는다`);
    }
  }

  // 7) 덮개 — 닫힌 묶음에서는 명단의 개수와 «정확히» 같아야 하고, 명단 항목은 현재 동작을 잠그는 시험을 인용해야 하며 그 시험이 «실제로 있어야» 한다
  const allowedOverlay = new Map<string, number>();
  const titlesCache = new Map<string, Set<string> | null>();
  const titlesOf = (testFile: string): Set<string> | null => {
    if (!titlesCache.has(testFile)) {
      let text: string | undefined;
      try {
        text = reader.read(testFile);
      } catch {
        text = undefined;
      }
      titlesCache.set(testFile, typeof text === 'string' ? activeTestTitles(text, testFile) : null);
    }
    return titlesCache.get(testFile) ?? null;
  };
  let lockedTests = 0;
  for (const e of exceptions) {
    if (!Array.isArray(e.kinds) || !e.kinds.includes(OVERLAY_KIND) || typeof e.file !== 'string') continue;
    const label = `예외 명단 «${e.file}»`;
    if (e.kinds.length !== 1) {
      problems.push(`${label}: «${OVERLAY_KIND}»은 다른 종류와 한 항목에 섞지 않는다(항목을 나눈다 — count가 종류마다 다르다)`);
      continue;
    }
    if (!closedFiles.has(e.file)) {
      problems.push(`${label}: «${OVERLAY_KIND}»은 닫힌 묶음(Group.closed)의 파일에만 올린다`);
      continue;
    }
    if (!Number.isInteger(e.count) || (e.count as number) < 1) {
      problems.push(`${label}: «${OVERLAY_KIND}»에는 개수(count, 1 이상 정수)가 필요하다`);
      continue;
    }
    if (allowedOverlay.has(e.file)) {
      problems.push(`${label}: «${OVERLAY_KIND}» 항목이 같은 파일에 둘 이상이다 — 한 항목으로 합쳐 count를 적는다`);
      continue;
    }
    allowedOverlay.set(e.file, e.count as number);
    if (!Array.isArray(e.lockedBy) || !e.lockedBy.length) {
      problems.push(`${label}: «${OVERLAY_KIND}»에는 현재 동작을 잠그는 시험(lockedBy: ['시험 파일::시험 제목', …])이 필요하다 — 까닭만으로 올리지 않는다`);
      continue;
    }
    for (const cite of e.lockedBy) {
      const at = typeof cite === 'string' ? cite.indexOf('::') : -1;
      if (at < 1 || at === cite.length - 2) {
        problems.push(`${label}: lockedBy «${String(cite)}»의 꼴이 '시험 파일::시험 제목'이 아니다`);
        continue;
      }
      const testFile = cite.slice(0, at);
      const title = cite.slice(at + 2);
      if (testFile.startsWith('/') || testFile.includes('\\') || testFile.split('/').some((seg) => seg === '..' || seg === '.')) {
        problems.push(`${label}: lockedBy 파일 «${testFile}»은 src 기준 상대 경로여야 한다(절대 경로 · 역슬래시 · . · .. 금지)`);
        continue;
      }
      if (!/\.test\.tsx?$/.test(testFile)) {
        problems.push(`${label}: lockedBy 파일 «${testFile}»이 시험 파일(.test.ts · .test.tsx)이 아니다`);
        continue;
      }
      const titles = titlesOf(testFile);
      if (titles === null) {
        problems.push(`${label}: lockedBy 시험 파일 «${testFile}»을 읽을 수 없다 — 파일이 지워지거나 옮겨졌다(옮겼다면 항목의 경로를 고친다)`);
      } else if (!titles.has(title)) {
        problems.push(`${label}: 잠그는 시험 «${title}»을 «${testFile}»에서 못 찾는다 — 시험이 지워졌거나 이름이 바뀌었거나 꺼졌다(skip · todo)`);
      } else {
        lockedTests += 1;
      }
    }
  }
  let overlayFound = 0;
  let overlayAllowed = 0;
  for (const rel of [...closedFiles].sort()) {
    const marks = scanOverlays(reader.read(rel), rel);
    const allowed = allowedOverlay.get(rel) ?? 0;
    overlayFound += marks.length;
    overlayAllowed += Math.min(allowed, marks.length);
    const show = (m: OverlayMark): string => `${rel}:${m.line} ${m.mark}`;
    if (marks.length > allowed) {
      problems.push(`손으로 지은 덮개 ${marks.length - allowed}곳 더(명단 ${allowed}곳): ${marks.slice(0, 3).map(show).join(' | ')} — 바탕 부품(Dialog · Sheet · Popover)으로 바꾼다. 못 바꾸면 까닭 + 현재 동작을 잠그는 시험(lockedBy)과 함께 명단에 올린다`);
    } else if (marks.length < allowed) {
      problems.push(`예외 명단 «${rel}»: 덮개 표시가 ${marks.length}곳뿐인데 ${allowed}곳이라 적혀 있다 — 낡은 항목이니 개수를 고치거나 걷는다`);
    }
  }

  // 8) 묶음 «밖» 덮개 — 소스 전체에 같은 셈을 돌려 기준선으로 고정한다(새 덮개가 묶음 밖에서 자라는 것을 막는다). 늘면 실패 · 줄면 허용.
  const outside = { scannedFiles: null as number | null, found: 0, baseline: 0, shrunk: [] as string[] };
  for (const [file, n] of Object.entries(outsideOverlayBaseline)) {
    if (!Number.isInteger(n) || n < 1) problems.push(`묶음 밖 덮개 기준선 «${file}»: 개수(1 이상 정수)가 필요하다`);
    else if (union.includes(file)) problems.push(`묶음 밖 덮개 기준선 «${file}»: 묶음 안의 파일이다 — 묶음 안은 기준선이 아니라 예외 명단(까닭 + 잠그는 시험)에 올린다`);
    else outside.baseline += n;
  }
  if (reader.listAll) {
    const inUnion = new Set(union);
    const all = reader.listAll().filter((f) => !inUnion.has(f));
    outside.scannedFiles = all.length;
    const seen = new Set<string>();
    for (const rel of all) {
      const marks = scanOverlays(reader.read(rel), rel);
      const base = outsideOverlayBaseline[rel] ?? 0;
      if (marks.length) seen.add(rel);
      outside.found += marks.length;
      if (marks.length > base) {
        problems.push(`묶음 밖 덮개 ${marks.length - base}곳 더(기준선 ${base}곳): ${marks.slice(0, 3).map((m) => `${rel}:${m.line} ${m.mark}`).join(' | ')} — 새 덮개는 바탕 부품(Dialog · Sheet · Popover)으로 만든다`);
      } else if (marks.length < base) {
        outside.shrunk.push(`${rel} (기준선 ${base}곳 → 지금 ${marks.length}곳)`);
      }
    }
    for (const file of Object.keys(outsideOverlayBaseline)) {
      if (!inUnion.has(file) && !all.includes(file)) problems.push(`묶음 밖 덮개 기준선 «${file}»: 그 파일이 없다 — 항목을 걷거나 경로를 고친다`);
    }
  }
  return {
    groups: stats,
    unionFiles: union.length,
    offFiles,
    rawControls: { closedFiles: closedFiles.size, found: rawFound, allowed: rawAllowed },
    overlays: { closedFiles: closedFiles.size, found: overlayFound, allowed: overlayAllowed, lockedTests },
    outsideOverlays: outside,
    problems,
  };
}

// ---- 실행 ----
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_ROOT = path.resolve(HERE, '../src');
export const EXCEPTIONS_PATH = path.resolve(HERE, 'design-base-exceptions.json');

function main(): number {
  const result = evaluate(fsReader(SRC_ROOT), GROUPS, loadExceptions(EXCEPTIONS_PATH), loadOutsideOverlayBaseline(EXCEPTIONS_PATH));
  console.log('[story 4831 AC4] 바탕 한 벌 — 묶음별 바탕 밖 파일');
  for (const g of result.groups) console.log(`  ${String(g.offFiles).padStart(3)} / ${String(g.files).padStart(3)}  ${g.name}`);
  console.log(`  합(고유 파일) ${result.offFiles.length} / ${result.unionFiles}`);
  console.log(`[날것 입력칸] 닫힌 묶음 ${result.rawControls.closedFiles}파일 — 찾은 ${result.rawControls.found}건 · 명단 허용 ${result.rawControls.allowed}건`);
  console.log(`[덮개] 닫힌 묶음 ${result.overlays.closedFiles}파일 — 찾은 ${result.overlays.found}곳 · 명단 허용 ${result.overlays.allowed}곳 · 인용한 잠금 시험 ${result.overlays.lockedTests}건 확인`);
  console.log(`[묶음 밖 덮개] 소스 전체 중 묶음 밖 ${result.outsideOverlays.scannedFiles ?? '-'}파일 — 찾은 ${result.outsideOverlays.found}곳 · 기준선 ${result.outsideOverlays.baseline}곳`);
  for (const line of result.outsideOverlays.shrunk) console.log(`  ⚠️ 기준선보다 줄었다(design-base-exceptions.json의 outsideOverlayBaseline을 내린다): ${line}`);
  if (result.problems.length) {
    console.error(`\nFAIL: ${result.problems.length}건`);
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error(
      '\n처방: 값을 토큰/눈금 클래스로 옮긴다(text-micro · text-editorial-meta · rounded-xl · bg-scrim-* · text-on-scrim …). ' +
        '바탕이 정할 수 없는 값(제3자 브랜드색 · 사용자 데이터 색 · 라이브러리 입력)일 때만 design-base-exceptions.json에 까닭과 함께 올린다.',
    );
    return 1;
  }
  console.log('OK: 바탕 밖 값 0 · 닫힌 묶음의 날것 입력칸 · 덮개는 명단 밖 0 · 묶음 밖 덮개는 기준선을 안 넘음');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
