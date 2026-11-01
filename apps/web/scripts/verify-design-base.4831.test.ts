/**
 * story 4831 AC4 — verify-design-base.ts 시험.
 *   ① 스캐너: 잡아야 하는 것 · 안 잡아야 하는 것(파이썬 측정 도구 count_base.py의 자기 시험 40여 개를 그대로 옮김)
 *   ② 판정: 임의 값 하나가 들어오면 실패 · 명단 항목은 까닭 필수 · 낡은 명단 · 묶음 경로 소실
 *   ③ 실제 소스 트리: 지금 develop은 0이다(이 시험이 빨개지면 verify:design-base도 빨갛다)
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STEPS,
  EXCEPTIONS_PATH,
  GROUPS,
  MIN_EXPECTED_FILES,
  OFF_KINDS,
  SRC_ROOT,
  evaluate,
  fsReader,
  loadExceptions,
  mapReader,
  scanText,
  stripComments,
  type ExceptionEntry,
  type Group,
  type Hits,
  type OffKind,
} from './verify-design-base';

const sc = (src: string): Hits => scanText(stripComments(src));
const n = (h: Hits, k: OffKind): number => h[k]?.length ?? 0;

describe('스캐너 — 잡아야 하는 것', () => {
  it('hex 따옴표 안', () => expect(n(sc("const c = '#3B5BA5';"), 'color_literal')).toBe(1));
  it('hex tailwind 임의', () => expect(n(sc('<div className="bg-[#fff] p-4">'), 'color_literal')).toBe(1));
  it('rgba 함수', () => expect(n(sc("style={{ background: 'rgba(0,0,0,0.5)' }}"), 'color_fn')).toBe(1));
  it('oklch 리터럴', () => expect(n(sc('color: oklch(0.7 0.1 200)'), 'color_fn')).toBe(1));
  it('팔레트 클래스', () => expect(n(sc('className="bg-red-500 dark:text-gray-300 hover:border-blue-600/50"'), 'color_palette')).toBe(3));
  it('bg-white / text-black', () => expect(n(sc('className="bg-white text-black"'), 'color_bw')).toBe(2));
  it('text-[13px]', () => expect(n(sc('className="text-[13px] md:text-[0.8rem]"'), 'font_arb')).toBe(2));
  it('fontSize inline', () => expect(n(sc('style={{ fontSize: 14 }}'), 'font_inline')).toBe(1));
  it('p-[7px]', () => expect(n(sc('className="p-[7px] -mt-[3px] gap-[2px]"'), 'space_arb')).toBe(3));
  it('padding inline', () => expect(n(sc("style={{ padding: 12, marginTop: '8px' }}"), 'space_inline')).toBe(2));
  it('rounded-[5px]', () => expect(n(sc('className="rounded-[5px] rounded-t-[3px]"'), 'radius_arb')).toBe(2));
  it('borderRadius inline', () => expect(n(sc('style={{ borderRadius: 6 }}'), 'radius_inline')).toBe(1));
  it('밑줄 뒤 rgba( 도 잡는다(shadow-[0_16px_46px_rgba(…)])', () =>
    expect(n(sc('className="shadow-[0_16px_46px_rgba(0,0,0,0.20)]"'), 'color_fn')).toBe(1));
  it('눈금 밖 글자: text-3xl · editorial-claim', () => expect(n(sc('className="text-3xl text-editorial-claim"'), 'font_off_scale')).toBe(2));
  it('#000 는 색', () => expect(n(sc("color: '#000'"), 'color_literal')).toBe(1));
  it('#abcd 알파 4자리는 색', () => expect(n(sc("color: '#abcd'"), 'color_literal')).toBe(1));
  it('URL 의 // 는 주석이 아니다(뒤의 색은 센다)', () => expect(n(sc("const u = 'http://a.b/#abc'; const c = '#fff';"), 'color_literal')).toBe(1));
  it('경로 글의 /* 는 주석 시작이 아니다', () => expect(n(sc("const g = 'src/**/*.ts'; const c = '#fff';"), 'color_literal')).toBe(1));
});

describe('스캐너 — 안 잡아야 하는 것', () => {
  it('주석 속 이슈 번호는 색이 아니다', () => expect(n(sc('// see #3127 and #2310\nconst a = 1;'), 'color_literal')).toBe(0));
  it('블록 주석 속 hex 는 색이 아니다', () => expect(n(sc('/* color #ffffff here */ const a = 1;'), 'color_literal')).toBe(0));
  it('href 앵커 #abc 는 색이 아니다', () => expect(n(sc('<a href="#abc">x</a>'), 'color_literal')).toBe(0));
  it('엔티티 &#39; 는 색이 아니다', () => expect(n(sc("const s = 'it&#39;s';"), 'color_literal')).toBe(0));
  it('영문자 뒤 xrgba( 는 색 함수가 아니다', () => expect(n(sc('const mergebgrgba = 1; foo_rgbaX(1)'), 'color_fn')).toBe(0));
  it('색 함수가 var()를 감싸도 센다 — 토큰은 var(--x) 그대로 쓴다(hsl · rgba 래퍼 금지)', () => {
    expect(n(sc('color: hsl(var(--x))'), 'color_fn')).toBe(1);
    expect(n(sc('background: rgba(var(--x), .5)'), 'color_fn')).toBe(1);
    expect(n(sc('color: var(--x)'), 'color_fn')).toBe(0);
  });
  it('타입 지정 임의 글자 크기도 센다(text-[length:13px] · calc · clamp), 값이 없는 inherit 는 아니다', () => {
    expect(n(sc('className="text-[length:13px]"'), 'font_arb')).toBe(1);
    expect(n(sc('className="md:text-[length:1.25rem]"'), 'font_arb')).toBe(1);
    expect(n(sc('className="text-[clamp(1rem,2vw,2rem)]"'), 'font_arb')).toBe(1);
    expect(n(sc('className="text-[length:inherit]"'), 'font_arb')).toBe(0);
  });
  it('문자열 속 // 는 주석이 아니다 — 뒤의 진짜 클래스를 지우지 않는다', () => {
    expect(n(sc('const a = "prefix // text-[13px]";'), 'font_arb')).toBe(1);
    expect(n(sc("const a = 'x /* y */ p-[7px]';"), 'space_arb')).toBe(1);
    expect(n(sc('const a = `list // rounded-[5px]`;'), 'radius_arb')).toBe(1);
  });
  it('같은 줄 끝 주석은 지운다(문자열 밖일 때), 따옴표가 닫힌 뒤의 주석도', () => {
    expect(n(sc('const a = 1; // text-[13px]'), 'font_arb')).toBe(0);
    expect(n(sc('const a = "it\'s"; // text-[13px]'), 'font_arb')).toBe(0);
    expect(n(sc('const a = 1; /* p-[7px] */ const b = 2;'), 'space_arb')).toBe(0);
  });
  it('토큰 클래스는 안 센다', () => expect(n(sc('className="bg-background text-foreground p-4 text-sm rounded-md"'), 'color_palette')).toBe(0));
  it('눈금 간격은 안 센다', () => expect(n(sc('className="p-4 gap-2 mt-6 py-0.5"'), 'space_arb')).toBe(0));
  it('text-sm 은 임의 크기가 아니다', () => expect(n(sc('className="text-sm"'), 'font_arb')).toBe(0));
  it('JSX 글 속 아포스트로피 뒤 주석도 지운다', () => expect(n(sc("<p>don't</p>\n  // story #2021 note\nconst a = 1;"), 'color_literal')).toBe(0));
  it('정규식 따옴표 뒤 주석도 지운다', () => expect(n(sc('const r = /[\'"]/;\n// issue #3949\n'), 'color_literal')).toBe(0));
  it('#NNNN 숫자 4자리는 이슈 번호', () => expect(n(sc("const s = 'story #2021';"), 'color_literal')).toBe(0));
  it('눈금 안 글자: micro · meta · ui · display · xs 는 눈금 밖이 아니다', () =>
    expect(n(sc('className="text-micro text-editorial-meta text-editorial-ui text-display text-xs"'), 'font_off_scale')).toBe(0));
  it('정한 눈금은 10단이다', () => expect(ALLOWED_STEPS.size).toBe(10));
  it('줄 번호를 지킨다(주석을 지워도 줄바꿈은 남는다)', () => expect(sc('/* a\nb */\nconst c = "#fff";').color_literal?.[0][0]).toBe(3));
});

describe('스캐너 — color-mix (토큰만 섞으면 바탕을 이미 거친 값)', () => {
  const MIX_TOKENS =
    "backgroundImage: 'repeating-linear-gradient(90deg, color-mix(in oklch, var(--proof-sunk) 35%, var(--proof-ink-3) 65%) 0 15px, color-mix(in oklch, var(--proof-sunk) 15%, var(--proof-ink-3) 85%) 15px 16px)'";
  it('인자가 전부 var() 토큰이면 세지 않는다(워크셀 눈금 한 줄)', () => expect(n(sc(MIX_TOKENS), 'color_fn')).toBe(0));
  it('리터럴 색이 하나라도 섞이면 센다', () => expect(n(sc('color-mix(in oklch, var(--a) 30%, #fff 70%)'), 'color_fn')).toBe(1));
  it('둘 다 리터럴이면 센다', () => expect(n(sc('color-mix(in srgb, red 40%, blue)'), 'color_fn')).toBe(1));
  it('토큰 하나뿐(짝 없음)이면 센다', () => expect(n(sc('color-mix(in oklch, var(--a) 30%)'), 'color_fn')).toBe(1));
  it('괄호가 닫히지 않으면 센다', () => expect(n(sc('color-mix(in oklch, var(--a) 30%, var(--b)'), 'color_fn')).toBe(1));
  it('var()의 폴백에 리터럴 색이 숨어 있으면 센다', () => {
    expect(n(sc('color-mix(in oklch, var(--a, red) 30%, var(--b) 70%)'), 'color_fn')).toBe(1);
    expect(n(sc('color-mix(in oklch, var(--a) 30%, var(--b, #fff) 70%)'), 'color_fn')).toBe(1);
  });
});

// ---- 판정 ----
const BASE_REASON = '바탕이 정할 수 없는 값이라 명단에 둔다(시험용 까닭)';
const CLEAN = 'export const A = () => <div className="p-4 text-sm bg-card text-foreground rounded-md" />;\n';
/** MIN_EXPECTED_FILES를 채우는 깨끗한 파일 묶음 하나짜리 소스. */
function cleanTree(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < MIN_EXPECTED_FILES + 5; i += 1) files[`components/one/f${i}.tsx`] = CLEAN;
  return { ...files, ...extra };
}
const ONE: Group[] = [{ name: '시험 묶음', prefixes: ['components/one'] }];
const run = (files: Record<string, string>, exceptions: ExceptionEntry[] = [], groups: Group[] = ONE) =>
  evaluate(mapReader(files), groups, exceptions);

describe('판정', () => {
  it('깨끗한 소스는 문제 0건', () => {
    const r = run(cleanTree());
    expect(r.problems).toEqual([]);
    expect(r.offFiles).toEqual([]);
    expect(r.groups[0].offFiles).toBe(0);
  });

  it('임의 값 하나가 들어오면 실패한다(양성 대조)', () => {
    for (const bad of ['text-[13px]', 'rounded-[5px]', 'p-[7px]', 'bg-white', 'bg-red-500', 'text-3xl']) {
      const r = run(cleanTree({ 'components/one/new.tsx': `export const B = () => <div className="${bad}" />;\n` }));
      expect(r.offFiles.map((o) => o.file), bad).toEqual(['components/one/new.tsx']);
      expect(r.problems.length, bad).toBeGreaterThan(0);
    }
    const hex = run(cleanTree({ 'components/one/new.tsx': 'export const C = { color: "#12ab34" };\n' }));
    expect(hex.offFiles).toHaveLength(1);
  });

  it('주석 속의 값은 세지 않는다', () => {
    const r = run(cleanTree({ 'components/one/c.tsx': '// text-[13px] #fff\n/* bg-white */\nexport const D = 1;\n' }));
    expect(r.problems).toEqual([]);
  });

  it('시험 · stories · .d.ts 파일은 검사 밖이다', () => {
    const r = run(
      cleanTree({
        'components/one/x.test.tsx': 'const a = "text-[13px]";',
        'components/one/x.stories.tsx': 'const a = "text-[13px]";',
        'components/one/__tests__/y.tsx': 'const a = "text-[13px]";',
        'components/one/z.d.ts': 'const a = "text-[13px]";',
      }),
    );
    expect(r.problems).toEqual([]);
  });

  it('명단에 올리면 그 종류는 통과한다', () => {
    const files = cleanTree({ 'components/one/brand.tsx': 'export const E = { fill: "#4285F4" };\n' });
    const ok = run(files, [{ file: 'components/one/brand.tsx', kinds: ['color_literal'], why: BASE_REASON }]);
    expect(ok.problems).toEqual([]);
    // 명단에 없는 다른 종류는 여전히 센다
    const other = run(
      { ...files, 'components/one/brand.tsx': 'export const E = { fill: "#4285F4" }; const k = "text-[13px]";\n' },
      [{ file: 'components/one/brand.tsx', kinds: ['color_literal'], why: BASE_REASON }],
    );
    expect(other.offFiles).toHaveLength(1);
  });

  it('명단 항목은 까닭이 필수다', () => {
    const files = cleanTree({ 'components/one/brand.tsx': 'export const E = { fill: "#4285F4" };\n' });
    for (const why of ['', '   ', '짧음']) {
      const r = run(files, [{ file: 'components/one/brand.tsx', kinds: ['color_literal'], why }]);
      expect(r.problems.some((p) => p.includes('까닭')), JSON.stringify(why)).toBe(true);
    }
  });

  it('명단의 종류 이름이 틀리거나 비면 실패한다', () => {
    const files = cleanTree({ 'components/one/brand.tsx': 'export const E = { fill: "#4285F4" };\n' });
    expect(run(files, [{ file: 'components/one/brand.tsx', kinds: ['color'], why: BASE_REASON }]).problems.some((p) => p.includes('모르는 종류'))).toBe(true);
    expect(run(files, [{ file: 'components/one/brand.tsx', kinds: [], why: BASE_REASON }]).problems.some((p) => p.includes('kinds가 비었다'))).toBe(true);
  });

  it('낡은 명단(적은 종류가 0건 · 파일이 묶음에 없음)은 실패한다', () => {
    const files = cleanTree();
    const noHit = run(files, [{ file: 'components/one/f1.tsx', kinds: ['color_literal'], why: BASE_REASON }]);
    expect(noHit.problems.some((p) => p.includes('0건'))).toBe(true);
    const gone = run(files, [{ file: 'components/one/gone.tsx', kinds: ['color_literal'], why: BASE_REASON }]);
    expect(gone.problems.some((p) => p.includes('그 파일이 없다'))).toBe(true);
  });

  it('명단 파일은 경로 정확히 일치만 한다(이름만 같은 다른 폴더의 파일은 안 가려진다)', () => {
    const brand = 'export const E = { fill: "#4285F4" };\n';
    const files = cleanTree({ 'components/one/brand.tsx': brand, 'components/one/deep/brand.tsx': brand, 'components/one/xbrand.tsx': brand });
    // 파일 이름만 적으면 아무것도 가리지 않고, 낡은 항목(그 파일이 없음)으로 실패한다
    const nameOnly = run(files, [{ file: 'brand.tsx', kinds: ['color_literal'], why: BASE_REASON }]);
    expect(nameOnly.offFiles.map((o) => o.file).sort()).toEqual(['components/one/brand.tsx', 'components/one/deep/brand.tsx', 'components/one/xbrand.tsx']);
    expect(nameOnly.problems.some((p) => p.includes('그 파일이 없다'))).toBe(true);
    // 전체 경로를 적으면 그 한 파일만 가린다
    const exact = run(files, [{ file: 'components/one/brand.tsx', kinds: ['color_literal'], why: BASE_REASON }]);
    expect(exact.offFiles.map((o) => o.file).sort()).toEqual(['components/one/deep/brand.tsx', 'components/one/xbrand.tsx']);
  });

  it('묶음 경로가 사라지거나 비면 실패한다(폴더 이동으로 가드가 헛도는 것을 막는다)', () => {
    const lost = run(cleanTree(), [], [...ONE, { name: '사라진 묶음', prefixes: ['components/moved'] }]);
    expect(lost.problems.some((p) => p.includes('경로가 없다'))).toBe(true);
    expect(lost.problems.some((p) => p.includes('파일이 하나도 없다'))).toBe(true);
  });

  it('검사 대상이 너무 적으면 실패한다', () => {
    const r = run({ 'components/one/a.tsx': CLEAN });
    expect(r.problems.some((p) => p.includes('헛돌고'))).toBe(true);
  });

  it('두 묶음에 걸친 파일은 고유 파일로 한 번만 센다', () => {
    const r = run(cleanTree(), [], [...ONE, { name: '겹침', prefixes: ['components/one/f1.tsx'] }]);
    expect(r.unionFiles).toBe(MIN_EXPECTED_FILES + 5);
  });
});

// ---- 실제 소스 트리 ----
describe('실제 소스 트리', () => {
  it('종류 목록은 11가지다', () => expect(OFF_KINDS).toHaveLength(11));

  it('develop은 바탕 밖 값 0 · 문제 0이다', () => {
    const r = evaluate(fsReader(SRC_ROOT), GROUPS, loadExceptions(EXCEPTIONS_PATH));
    expect(r.problems).toEqual([]);
    expect(r.offFiles).toEqual([]);
    expect(r.unionFiles).toBeGreaterThanOrEqual(MIN_EXPECTED_FILES);
    for (const g of r.groups) expect(g.files, g.name).toBeGreaterThan(0);
  });

  it('양성 대조: 실제 파일 하나에 임의 값을 넣으면 같은 판정이 빨개진다', () => {
    const reader = fsReader(SRC_ROOT);
    const target = 'components/ui/badge.tsx';
    const patched = {
      list: reader.list,
      read: (rel: string) => (rel === target ? `${reader.read(rel)}\nexport const Injected = 'text-[13px]';\n` : reader.read(rel)),
    };
    const r = evaluate(patched, GROUPS, loadExceptions(EXCEPTIONS_PATH));
    expect(r.offFiles.map((o) => o.file)).toEqual([target]);
  });

  it('명단의 모든 항목에 까닭이 있다', () => {
    for (const e of loadExceptions(EXCEPTIONS_PATH)) expect(e.why.trim().length, e.file).toBeGreaterThanOrEqual(10);
  });
});
