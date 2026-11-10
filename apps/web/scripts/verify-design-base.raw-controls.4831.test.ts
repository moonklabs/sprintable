/**
 * story 4831 — verify-design-base.ts의 «날것 입력칸»(raw_control) 종류 시험.
 *   ① 스캐너(구문 트리): 날 <input> · <textarea> · <select>만 센다 — 부품 · 문자열 · 주석 속 마크업은 안 센다
 *   ② 판정: 닫힌 묶음에서는 명단 개수와 «정확히» 같아야 한다(늘면 새 날것 · 모자라면 낡은 항목) · 열린 묶음은 안 센다
 *   ③ 실제 소스 트리: 닫힌 아홉 묶음(전부)의 날것은 명단 13건뿐이고 문제 0이다
 */
import { describe, expect, it } from 'vitest';
import {
  EXCEPTIONS_PATH,
  GROUPS,
  MIN_EXPECTED_FILES,
  RAW_KIND,
  SRC_ROOT,
  evaluate,
  fsReader,
  loadExceptions,
  loadOutsideOverlayBaseline,
  mapReader,
  scanRawControls,
  type ExceptionEntry,
  type Group,
} from './verify-design-base';

describe('scanRawControls — 잡아야 하는 것', () => {
  it('날 input · textarea · select(여닫는 짝과 자기닫힘 모두)와 줄 번호', () => {
    const src = ['export const A = () => (', '  <>', '    <input />', '    <textarea rows={2}></textarea>', '    <select><option /></select>', '  </>', ');'].join('\n');
    expect(scanRawControls(src).map((c) => [c.tag, c.line])).toEqual([['input', 3], ['textarea', 4], ['select', 5]]);
  });
  it('type이 문자열 상수면 적는다(hidden · file · checkbox), 식이거나 없으면 null', () => {
    const src = `export const B = ({ t }) => (<><input type="hidden" /><input type='file' /><input type={t} /><input /></>);`;
    expect(scanRawControls(src).map((c) => c.type)).toEqual(['hidden', 'file', null, null]);
  });
  it('조건 안 · 반복 안에 있어도 센다', () => {
    const src = `export const C = ({ xs, on }) => (<ul>{on ? <input /> : null}{xs.map((x) => <li key={x}><textarea /></li>)}</ul>);`;
    expect(scanRawControls(src)).toHaveLength(2);
  });
});

describe('scanRawControls — 안 잡아야 하는 것', () => {
  it('부품(대문자 이름)은 안 센다', () => {
    expect(scanRawControls('export const D = () => (<><Input /><Textarea /><Select><option /></Select><Checkbox /><RadioGroupItem /></>);')).toEqual([]);
  });
  it('문자열 · 템플릿 속 마크업은 안 센다(HTML을 만드는 변환기 — content-converter 꼴)', () => {
    const src = "export const h = (on: boolean) => '<input type=\"checkbox\"' + (on ? ' checked' : '') + '>';\nexport const t = `<textarea>${1}</textarea><select></select>`;";
    expect(scanRawControls(src, 'lib/convert.ts')).toEqual([]);
  });
  it('주석 · JSX 글자 속 이름은 안 센다', () => {
    const src = ['// <input /> 를 부품으로', '/* <textarea> */', 'export const E = () => <p>{/* <select /> */}여기에 &lt;input&gt; 글자</p>;'].join('\n');
    expect(scanRawControls(src)).toEqual([]);
  });
  it('이름이 점으로 이어진 태그와 비슷한 이름은 안 센다', () => {
    expect(scanRawControls('export const F = () => (<><ui.input /><inputs /><my-select /></>);')).toEqual([]);
  });
  it('JSX가 없는 .ts(제네릭 화살표)도 던지지 않고 0이다', () => {
    expect(scanRawControls('export const id = <T,>(x: T): T => x;\nexport const g = <T>(x: T) => x;', 'lib/x.ts')).toEqual([]);
  });
});

// ---- 판정 ----
const REASON = '부품이 없는 입력이라 명단에 둔다(시험용 까닭 열 글자 넘김)';
const CLEAN = 'export const A = () => <div className="p-4 text-sm bg-card text-foreground rounded-md" />;\n';
const WITH_INPUT = 'export const B = () => <div><input type="text" /></div>;\n';
function tree(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < MIN_EXPECTED_FILES + 5; i += 1) files[`components/one/f${i}.tsx`] = CLEAN;
  return { ...files, ...extra };
}
const CLOSED: Group[] = [{ name: '닫힌 시험 묶음', prefixes: ['components/one'], closed: true }];
const OPEN: Group[] = [{ name: '열린 시험 묶음', prefixes: ['components/one'] }];
const run = (files: Record<string, string>, exceptions: ExceptionEntry[] = [], groups: Group[] = CLOSED) => evaluate(mapReader(files), groups, exceptions);
const raw = (file: string, count: number | undefined, why = REASON): ExceptionEntry => ({ file, kinds: [RAW_KIND], why, ...(count === undefined ? {} : { count }) });

describe('판정 — 닫힌 묶음의 날것 입력칸', () => {
  it('깨끗한 닫힌 묶음은 문제 0 · 날것 0', () => {
    const r = run(tree());
    expect(r.problems).toEqual([]);
    expect(r.rawControls).toMatchObject({ found: 0, allowed: 0 });
  });
  it('날것 하나가 들어오면 실패하고 파일 · 줄 · 태그 · type을 알려 준다(양성 대조)', () => {
    const r = run(tree({ 'components/one/new.tsx': WITH_INPUT }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('날것 입력칸 1건 더(명단 0건)');
    expect(r.problems[0]).toContain('components/one/new.tsx:1 <input type="text">');
  });
  it('명단에 개수가 맞게 올라 있으면 통과한다', () => {
    const r = run(tree({ 'components/one/new.tsx': WITH_INPUT }), [raw('components/one/new.tsx', 1)]);
    expect(r.problems).toEqual([]);
    expect(r.rawControls).toMatchObject({ found: 1, allowed: 1 });
  });
  it('명단 개수보다 날것이 늘면(새로 하나 더) 실패한다', () => {
    const two = 'export const B = () => <div><input /><textarea /></div>;\n';
    const r = run(tree({ 'components/one/new.tsx': two }), [raw('components/one/new.tsx', 1)]);
    expect(r.problems.join(' | ')).toContain('날것 입력칸 1건 더(명단 1건)');
  });
  it('명단 개수보다 날것이 줄면(교체해서 낡았다) 실패한다', () => {
    const r = run(tree({ 'components/one/new.tsx': WITH_INPUT }), [raw('components/one/new.tsx', 2)]);
    expect(r.problems.join(' | ')).toContain('날것 입력칸이 1건뿐인데 2건이라 적혀 있다');
  });
  it('날것이 0인데 명단에 올라 있으면 낡은 항목으로 실패한다', () => {
    const r = run(tree(), [raw('components/one/f0.tsx', 1)]);
    expect(r.problems.join(' | ')).toContain('날것 입력칸이 0건뿐인데 1건이라 적혀 있다');
  });
  it('개수가 없거나 0 · 소수면 실패한다', () => {
    for (const count of [undefined, 0, 1.5, -1]) {
      const r = run(tree({ 'components/one/new.tsx': WITH_INPUT }), [raw('components/one/new.tsx', count)]);
      expect(r.problems.join(' | '), String(count)).toContain('개수(count, 1 이상 정수)가 필요하다');
    }
  });
  it('까닭이 짧거나 없으면 실패한다(기존 규칙 그대로)', () => {
    const r = run(tree({ 'components/one/new.tsx': WITH_INPUT }), [raw('components/one/new.tsx', 1, '짧음')]);
    expect(r.problems.join(' | ')).toContain('까닭(why)이 없거나 너무 짧다');
  });
  it('닫히지 않은 묶음의 파일을 날것 예외로 올리면 실패한다', () => {
    const r = run(tree({ 'components/one/new.tsx': WITH_INPUT }), [raw('components/one/new.tsx', 1)], OPEN);
    expect(r.problems.join(' | ')).toContain('닫힌 묶음(Group.closed)의 파일에만 올린다');
  });
  it('같은 파일에 날것 예외 항목이 둘이면 합이 맞아도 실패한다(항목마다 정확히 — 한 항목으로 합쳐 count를 적는다)', () => {
    const two = 'export const B = () => <div><input /><textarea /></div>;\n';
    // 실제 개수 2 = 항목 둘의 count 합 2 — 합산하던 때는 문제 0이었다
    const r = run(tree({ 'components/one/new.tsx': two }), [raw('components/one/new.tsx', 1), raw('components/one/new.tsx', 1)]);
    expect(r.problems.join(' | ')).toContain('항목이 같은 파일에 둘 이상이다');
    // 한 항목으로 합치면 통과한다
    const merged = run(tree({ 'components/one/new.tsx': two }), [raw('components/one/new.tsx', 2)]);
    expect(merged.problems).toEqual([]);
  });
  it('열린 묶음은 날것을 세지 않는다(아직 교체 중인 묶음)', () => {
    const r = run(tree({ 'components/one/new.tsx': WITH_INPUT }), [], OPEN);
    expect(r.problems).toEqual([]);
    expect(r.rawControls.closedFiles).toBe(0);
  });
  it('문자열 속 마크업은 닫힌 묶음에서도 안 센다', () => {
    const r = run(tree({ 'components/one/conv.ts': "export const h = () => '<input type=\"checkbox\">';\n" }));
    expect(r.problems).toEqual([]);
  });
  it('날것 예외는 다른 종류(색)의 명단 규칙과 섞여도 각자 본다', () => {
    const r = run(tree({ 'components/one/new.tsx': `${WITH_INPUT}export const C = { color: '#12ab34' };\n` }), [
      { file: 'components/one/new.tsx', kinds: [RAW_KIND, 'color_literal'], count: 1, why: REASON },
    ]);
    expect(r.problems).toEqual([]);
  });
});

// ---- 실제 소스 트리 ----
describe('실제 소스 트리 — 닫힌 묶음의 날것 입력칸', { timeout: 30_000 }, () => {
  const closedNames = GROUPS.filter((g) => g.closed).map((g) => g.name);
  it('묶음 아홉이 모두 닫혀 있다(공용 부품 · 바탕 부품까지 — 교체가 끝났다)', () => {
    expect(GROUPS).toHaveLength(9);
    expect(closedNames).toHaveLength(9);
    for (const g of GROUPS) expect(g.closed, g.name).toBe(true);
  });
  it('날것은 명단 13건뿐이고 문제 0이다(첫 실행 길 4 · 대화 1 · 보드 1 · 문서 2 · 공용 3 · 바탕 정의 2)', () => {
    const r = evaluate(fsReader(SRC_ROOT), GROUPS, loadExceptions(EXCEPTIONS_PATH), loadOutsideOverlayBaseline(EXCEPTIONS_PATH));
    expect(r.problems).toEqual([]);
    expect(r.rawControls.found).toBe(13);
    expect(r.rawControls.allowed).toBe(13);
    const listed = loadExceptions(EXCEPTIONS_PATH).filter((e) => e.kinds.includes(RAW_KIND));
    expect(listed.reduce((n, e) => n + (e.count ?? 0), 0)).toBe(13);
    for (const e of listed) expect(e.why.trim().length, e.file).toBeGreaterThanOrEqual(10);
  });
  it('양성 대조: 새로 닫힌 두 묶음에 날 입력칸을 넣어도 빨개진다(공용 부품 · 바탕 부품)', () => {
    const reader = fsReader(SRC_ROOT);
    for (const target of ['components/nav/unified-switcher.tsx', 'components/ui/badge.tsx']) {
      const patched = { list: reader.list, read: (rel: string) => (rel === target ? `${reader.read(rel)}\nexport const Injected = () => <textarea />;\n` : reader.read(rel)) };
      const r = evaluate(patched, GROUPS, loadExceptions(EXCEPTIONS_PATH));
      expect(r.problems.join(' | '), target).toContain(`날것 입력칸 1건 더(명단 0건): ${target}`);
    }
  });
  it('양성 대조: 명단에서 부품 정의 자신(ui/select) 항목을 빼면 새 날것으로 잡힌다', () => {
    const without = loadExceptions(EXCEPTIONS_PATH).filter((e) => e.file !== 'components/ui/select.tsx');
    const r = evaluate(fsReader(SRC_ROOT), GROUPS, without, loadOutsideOverlayBaseline(EXCEPTIONS_PATH));
    expect(r.problems.join(' | ')).toContain('날것 입력칸 1건 더(명단 0건): components/ui/select.tsx');
  });
  it('양성 대조: 실제 닫힌 파일에 날 입력칸을 넣으면 같은 판정이 빨개진다', () => {
    const reader = fsReader(SRC_ROOT);
    const target = 'app/login/page.tsx';
    const patched = { list: reader.list, read: (rel: string) => (rel === target ? `${reader.read(rel)}\nexport const Injected = () => <input />;\n` : reader.read(rel)) };
    const r = evaluate(patched, GROUPS, loadExceptions(EXCEPTIONS_PATH));
    expect(r.problems.join(' | ')).toContain(`날것 입력칸 1건 더(명단 0건): ${target}`);
  });
  it('양성 대조: 명단에서 한 항목을 빼면 그 파일의 날것이 새 날것으로 잡힌다', () => {
    const without = loadExceptions(EXCEPTIONS_PATH).filter((e) => e.file !== 'components/docs/doc-editor.tsx');
    const r = evaluate(fsReader(SRC_ROOT), GROUPS, without, loadOutsideOverlayBaseline(EXCEPTIONS_PATH));
    expect(r.problems.join(' | ')).toContain('날것 입력칸 2건 더(명단 0건): components/docs/doc-editor.tsx');
  });
  it('양성 대조: HTML 문자열을 만드는 변환기(content-converter)의 «<input»은 안 센다', () => {
    const reader = fsReader(SRC_ROOT);
    expect(reader.read('components/docs/lib/content-converter.ts')).toContain('<input');
    expect(scanRawControls(reader.read('components/docs/lib/content-converter.ts'), 'components/docs/lib/content-converter.ts')).toEqual([]);
  });
});
