/**
 * story 5048 ③d — «박힌 디자인 값» 래칫의 측정부(순수 함수 — 파일을 읽지 않는 `measureContent`와 트리를 도는 `measureTree`).
 * 키트 규칙(간격 4/8/12/16/24/32 · 높이 40 · 글자 16 · 그림자 0 · 색은 역할 토큰)에서 벗어나는 «값이 박힌 클래스»를 분류별로 센다.
 * 이미 시험이 막는 분류는 여기서 뺐다(중복 0) — 알파 배경 → `styles/alpha-bg.5048.test.ts` · 알파 테두리 · 링 · 글자 → `styles/alpha-line-text.5048.test.ts` · 색 값 직접 → `styles/color-literals.5048.test.ts` · 아이콘 크기 → `styles/icon-size-steps.5048.test.ts` · 글자 든 고정 높이 → `styles/fixed-height-text.5048.test.ts` · 4의 배수 임의 크기 → `styles/arbitrary-px-grid.5048.test.ts`(여기 `arbitrary-size`는 그 시험이 안 막는 «4의 배수가 아닌 값»이 몫).
 * 센 수를 `hardcoded-design-values-baseline.json`에 못 박아 **늘면 RED**(새 박힌 값이 못 들어옴) — 줄면 기준선도 줄이게 한다(분류별 `strict`).
 * 주석 속 클래스 이름은 세지 않는다(i18n-key-parser의 stripComments — 다른 verify 가드와 같은 관례).
 * 이 파일은 «무엇을 세는가»만 안다 — 기준선 비교 · 메시지는 verify-no-hardcoded-design-values.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../../../packages/scripts/i18n-key-parser.js';

/** Tailwind 변형 접두(`sm:` · `hover:` · `dark:` · `[&>x]:` · `group-hover/x:` …) — 클래스 토큰 앞에 붙는 것. */
const VARIANTS = String.raw`(?:[a-z0-9@\[\]()_.:&>*=%/-]+:)*-?`;
const BOUNDARY_BEFORE = String.raw`(?<![A-Za-z0-9_\[\]-])`;
const BOUNDARY_AFTER = String.raw`(?![A-Za-z0-9_-])`;

const SIZE_PROPS = [
  'min-h', 'max-h', 'min-w', 'max-w', 'size', 'h', 'w', 'basis',
  'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe', 'p',
  'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me', 'm',
  'gap-x', 'gap-y', 'gap', 'space-x', 'space-y',
  'inset-x', 'inset-y', 'inset', 'top', 'bottom', 'left', 'right', 'start', 'end',
].sort((a, b) => b.length - a.length).join('|');

/** 옛 별칭 색 이름(`app/globals.css` 별칭 층 · `proof-*`) — ds-* 토큰이 아닌 이름. */
const LEGACY_COLOR = String.raw`(?:background|foreground|card(?:-foreground)?|popover(?:-foreground)?|primary(?:-foreground)?|secondary(?:-foreground)?|muted(?:-foreground)?|accent(?:-foreground)?|destructive(?:-[a-z]+)?|border|input|ring|brand(?:-[a-z]+)?|success(?:-[a-z]+)?|warning(?:-[a-z]+)?|info(?:-[a-z]+)?|proof-[a-z0-9-]+)`;
const COLOR_UTILS = 'bg|text|border(?:-[trblxy])?|ring|fill|stroke|divide|outline|decoration|from|to|via|accent|caret';

export interface Category {
  id: string;
  /** 사람이 읽는 이름 */
  label: string;
  /** 걷는 길(기준선을 줄이는 방법) */
  how: string;
  /** true면 줄어도 FAIL(기준선을 같이 줄이게 강제) · false면 줄어도 경고만(큰 수 — 남의 PR이 우연히 줄여도 막지 않음) */
  strict: boolean;
  re: RegExp;
}

export const CATEGORIES: Category[] = [
  {
    id: 'arbitrary-size',
    label: '임의 크기 `h-[Npx]` · `p-[Npx]` · `gap-[Npx]` …',
    how: '4의 배수는 간격 단계(`w-70`), 44는 `ds-touch`, 나머지는 가장 가까운 단계 · 키트 높이 토큰으로',
    strict: true,
    re: new RegExp(`${BOUNDARY_BEFORE}${VARIANTS}(?:${SIZE_PROPS})-\\[\\d+px\\]${BOUNDARY_AFTER}`, 'g'),
  },
  {
    id: 'arbitrary-text-size',
    label: '임의 글자 크기 `text-[Npx]`',
    how: '`text-xs`(16) · `text-ds-small` 등 ds 글자 단계로',
    strict: true,
    re: new RegExp(`${BOUNDARY_BEFORE}${VARIANTS}text-\\[\\d+(?:\\.\\d+)?(?:px|rem)\\]${BOUNDARY_AFTER}`, 'g'),
  },
  {
    id: 'arbitrary-radius',
    label: '임의 모서리 `rounded-[…]`',
    how: '`rounded-ds-control`(8) · `rounded-ds-bubble`(16) · 원으로',
    strict: true,
    re: new RegExp(`${BOUNDARY_BEFORE}${VARIANTS}rounded(?:-[a-z]{1,2})?-\\[[^\\]\\s]+\\]${BOUNDARY_AFTER}`, 'g'),
  },
  {
    id: 'direct-shadow',
    label: '직접 그림자 `shadow-sm|md|lg|xl|2xl` · `shadow-[…]`',
    how: '지운다(키트: 그림자 0 — 정의 한 곳에서 none이라 보이진 않음) + 면 차이 · 1px 선',
    strict: true,
    re: new RegExp(`${BOUNDARY_BEFORE}${VARIANTS}shadow-(?:2xs|xs|sm|md|lg|xl|2xl|\\[[^\\]\\s]+\\])${BOUNDARY_AFTER}`, 'g'),
  },
  {
    id: 'old-alias-color',
    label: '옛 별칭 색 `bg-primary` · `text-muted-foreground` · `border-border` · `proof-*` …',
    how: '새로 쓰지 않는다(새 코드는 `ds-*` 토큰) — 값은 이미 ds를 따라오므로 걷기는 선택(화면 손댈 때 같이)',
    strict: false,
    re: new RegExp(`${BOUNDARY_BEFORE}${VARIANTS}(?:${COLOR_UTILS})-${LEGACY_COLOR}(?:\\/(?:\\d+|\\[[0-9.]+\\]))?${BOUNDARY_AFTER}`, 'g'),
  },
  {
    id: 'editorial-text',
    label: '작은 글자 정의 `text-editorial-ui`(13) · `text-editorial-meta`(11)',
    how: '정의 한 곳에서 16으로(②d처럼) — 호출부 0곳 변경',
    strict: false,
    re: new RegExp(`${BOUNDARY_BEFORE}${VARIANTS}text-editorial-(?:ui|meta)${BOUNDARY_AFTER}`, 'g'),
  },
  {
    id: 'inline-style-px',
    label: '인라인 스타일 크기 `style={{ width|height|minHeight|… : 123 | \'123px\' }}`',
    how: '클래스(간격 단계 · 토큰)로 — 값이 계산식(`clamp(...)`)이면 CSS 변수로',
    strict: true,
    re: /(?<![A-Za-z0-9_])(?:width|height|minWidth|maxWidth|minHeight|maxHeight|padding(?:Top|Bottom|Left|Right)?|margin(?:Top|Bottom|Left|Right)?|gap|top|bottom|left|right):\s*(?:\d+|'\d+px'|"\d+px")(?=\s*[,}])/g,
  },
];

export type Counts = Record<string, number>;

export function measureContent(content: string): Counts {
  const stripped = stripComments(content) as string;
  const counts: Counts = {};
  for (const c of CATEGORIES) counts[c.id] = [...stripped.matchAll(c.re)].length;
  return counts;
}

const TEST_RE = /\.(test|spec)\.[tj]sx?$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

/** src 전체(시험 · 스펙 파일 제외)의 분류별 개수. `.css`는 토큰 정의 파일이라 세지 않는다. */
export function measureTree(srcRoot: string): Counts {
  const files: string[] = [];
  walk(srcRoot, files);
  const total: Counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  for (const f of files) {
    const n = measureContent(readFileSync(f, 'utf8'));
    for (const c of CATEGORIES) total[c.id]! += n[c.id] ?? 0;
  }
  return total;
}

