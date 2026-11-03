/**
 * story 4831 — verify-design-base.ts의 «덮개»(overlay) 종류 시험.
 *   ① 스캐너: `fixed inset-0` · `role="dialog"`를 센다(주석을 지운 뒤 — 4816 인벤토리와 같은 정의) · 비슷한 이름은 안 센다
 *   ② 시험 제목 추출: 명단이 인용한 시험이 «켜져 있나» — it/test의 정적 문자열 제목만, skip · todo · xdescribe 아래는 뺀다
 *   ③ 판정: 닫힌 묶음에서 명단 개수와 «정확히» 같아야 하고, 항목은 잠그는 시험(lockedBy)을 인용해야 하며 그 시험이 실제로 있어야 한다
 */
import { describe, expect, it } from 'vitest';
import {
  EXCEPTIONS_PATH,
  GROUPS,
  MIN_EXPECTED_FILES,
  OVERLAY_KIND,
  RAW_KIND,
  activeTestTitles,
  evaluate,
  fsReader,
  loadExceptions,
  loadOutsideOverlayBaseline,
  mapReader,
  scanOverlays,
  SRC_ROOT,
  type ExceptionEntry,
  type Group,
  type SourceReader,
} from './verify-design-base';

// 실제 소스 트리를 통째로 도는 시험은 CI 러너(느리고 공유)에서 기본 5초를 넘긴다 — 한 시험은 평가 한 번만 하고, 파일은 한 번만 읽고, 제한은 넉넉히 둔다.
const REAL = { timeout: 30_000 };
const cached = (r: SourceReader): SourceReader => {
  const memo = new Map<string, string>();
  return { ...r, read: (rel: string) => { if (!memo.has(rel)) memo.set(rel, r.read(rel)); return memo.get(rel) as string; } };
};

describe('scanOverlays — 잡아야 하는 것', () => {
  it('class 문자열 속 fixed inset-0(공백 여럿 · 줄바꿈 포함)와 손으로 쓴 role="dialog"(큰 · 작은 따옴표 · {"…"} 식)를 위치 순서와 줄 번호로', () => {
    const src = [
      'export const A = () => (',
      '  <div className="fixed inset-0 z-50">',
      "    <div role='dialog' />",
      '    <div role="dialog" className={`fixed',
      '      inset-0`} />',
      '    <div role={"dialog"} />',
      '  </div>',
      ');',
    ].join('\n');
    expect(scanOverlays(src).map((m) => [m.mark, m.line])).toEqual([['fixed inset-0', 2], ['role=dialog', 3], ['role=dialog', 4], ['fixed inset-0', 4], ['role=dialog', 6]]);
  });
  it('토큰 순서가 반대이거나 사이에 다른 클래스가 끼어도 센다(fixed top-0 … inset-0 · inset-0 fixed)', () => {
    const src = "export const B = () => (<><div className=\"inset-0 fixed z-40\" /><div className=\"fixed z-50 bg-scrim-1 inset-0\" /></>);";
    expect(scanOverlays(src)).toHaveLength(2);
  });
  it('조건 · cn() 안의 문자열도 센다', () => {
    const src = "export const C = ({ on }) => <div className={cn(on ? 'fixed inset-0 z-40' : 'hidden', 'p-2')} />;";
    expect(scanOverlays(src)).toHaveLength(1);
  });
  it('JSX가 없는 .ts의 문자열도 센다(클래스를 상수로 둔 파일)', () => {
    expect(scanOverlays("export const OVERLAY = 'fixed inset-0 z-50 bg-scrim-1';", 'lib/x.ts')).toHaveLength(1);
  });
});

describe('scanOverlays — 안 잡아야 하는 것', () => {
  it('주석 속 언급은 안 센다', () => {
    const src = ['// fixed inset-0 로 덮던 것', '/* role="dialog" */', 'export const D = () => <div className="p-4" />;'].join('\n');
    expect(scanOverlays(src)).toEqual([]);
  });
  it('비슷한 클래스 · 역할은 안 센다 — inset-y-0 · absolute inset-0 · inset-0 단독 · fixed 단독 · inset-0.5 · alertdialog · dialogue', () => {
    const src = [
      'export const E = () => (<>',
      '  <div className="fixed inset-y-0 left-0" />',
      '  <div className="absolute inset-0" />',
      '  <div className="inset-0" />',
      '  <div className="fixed top-0" />',
      '  <div className="fixed inset-0.5" />',
      '  <div role="alertdialog" />',
      '  <div role="dialogue" />',
      '</>);',
    ].join('\n');
    expect(scanOverlays(src)).toEqual([]);
  });
  it('role이 문자열 속 글자이거나 식이면 안 센다(JSX 속성으로 손으로 쓴 것만)', () => {
    const src = "export const F = ({ r }) => (<><div role={r} /><p>{'role=\"dialog\"'}</p></>);";
    expect(scanOverlays(src)).toEqual([]);
  });
});

describe('activeTestTitles — 켜져 있는 시험 제목', () => {
  const SRC = [
    "import { describe, it, test } from 'vitest';",
    "describe('묶음', () => {",
    "  it('정적 제목', () => {});",
    "  test('test로 쓴 제목', () => {});",
    '  it(`템플릿이지만 보간 없음`, () => {});',
    '  it(`보간 ${1} 있음`, () => {});',
    "  it('이어' + '붙인 제목', () => {});",
    "  it.skip('꺼진 제목', () => {});",
    "  it.todo('할 일 제목');",
    "  xit('xit 제목', () => {});",
    "  describe.skip('꺼진 묶음', () => { it('꺼진 묶음 속 제목', () => {}); });",
    "  xdescribe('x 묶음', () => { it('x 묶음 속 제목', () => {}); });",
    "  describe.each([1, 2])('표 %s', () => { it('표 속 정적 제목', () => {}); });",
    '});',
  ].join('\n');
  it('정적 문자열 · 보간 없는 템플릿 제목만 모은다', () => {
    const t = activeTestTitles(SRC);
    for (const title of ['정적 제목', 'test로 쓴 제목', '템플릿이지만 보간 없음', '표 속 정적 제목']) expect(t.has(title), title).toBe(true);
  });
  it('보간 · 이어붙인 제목은 정적이 아니라 못 읽는다', () => {
    const t = activeTestTitles(SRC);
    expect(t.has('보간 1 있음')).toBe(false);
    expect([...t].some((x) => x.includes('이어'))).toBe(false);
  });
  it('skip · todo · xit · skip/xdescribe 아래의 시험은 켜진 것으로 안 센다', () => {
    const t = activeTestTitles(SRC);
    for (const title of ['꺼진 제목', '할 일 제목', 'xit 제목', '꺼진 묶음 속 제목', 'x 묶음 속 제목']) expect(t.has(title), title).toBe(false);
  });
  it('호출 사슬 안쪽의 skip · skipIf · runIf · xdescribe.each 아래도 꺼진 것이다(표 형태 describe.skip.each(…)(…) 포함)', () => {
    const chains = [
      "describe.skip.each([1, 2])('표 %s', () => { it('skip.each 속 제목', () => {}); });",
      "xdescribe.each([1])('x표', () => { it('xdescribe.each 속 제목', () => {}); });",
      "describe.skipIf(true)('조건부', () => { it('skipIf 속 제목', () => {}); });",
      "describe.runIf(false)('조건부2', () => { it('runIf 속 제목', () => {}); });",
      "describe.todo('할 일 묶음', () => { it('todo 묶음 속 제목', () => {}); });",
      "describe.each([1])('켜진 표', () => { it('켜진 each 속 제목', () => {}); });",
      "describe('켜진', () => { describe.skip('안쪽 꺼짐', () => { it('안쪽 꺼진 제목', () => {}); }); it('바깥 켜진 제목', () => {}); });",
    ].join('\n');
    const t = activeTestTitles(chains);
    for (const off of ['skip.each 속 제목', 'xdescribe.each 속 제목', 'skipIf 속 제목', 'runIf 속 제목', 'todo 묶음 속 제목', '안쪽 꺼진 제목']) expect(t.has(off), off).toBe(false);
    for (const on of ['켜진 each 속 제목', '바깥 켜진 제목']) expect(t.has(on), on).toBe(true);
  });
});

// ---- 판정 ----
const REASON = '부품으로 못 옮기는 덮개라 명단에 둔다(시험용 까닭 열 글자 넘김)';
const CLEAN = 'export const A = () => <div className="p-4 text-sm bg-card text-foreground rounded-md" />;\n';
const WITH_OVERLAY = 'export const B = () => <div className="fixed inset-0 z-50" role="dialog" />;\n'; // 표시 2곳
const LOCK_FILE = 'components/one/lock.test.tsx';
const LOCK_SRC = "import { it } from 'vitest';\nit('잠금 시험 하나', () => {});\nit('잠금 시험 둘', () => {});\nit.skip('꺼진 시험', () => {});\n";
function tree(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < MIN_EXPECTED_FILES + 5; i += 1) files[`components/one/f${i}.tsx`] = CLEAN;
  return { ...files, [LOCK_FILE]: LOCK_SRC, ...extra };
}
const CLOSED: Group[] = [{ name: '닫힌 시험 묶음', prefixes: ['components/one'], closed: true }];
const OPEN: Group[] = [{ name: '열린 시험 묶음', prefixes: ['components/one'] }];
const run = (files: Record<string, string>, exceptions: ExceptionEntry[] = [], groups: Group[] = CLOSED) => evaluate(mapReader(files), groups, exceptions);
// lockedBy: 생략하려면 null(undefined는 기본값을 쓰게 한다)
const ov = (file: string, count: number | undefined, lockedBy: string[] | null = [`${LOCK_FILE}::잠금 시험 하나`], why = REASON): ExceptionEntry => ({
  file,
  kinds: [OVERLAY_KIND],
  why,
  ...(count === undefined ? {} : { count }),
  ...(lockedBy === null ? {} : { lockedBy }),
});
const NEW = 'components/one/new.tsx';
const problemsOf = (r: ReturnType<typeof run>) => r.problems.join(' | ');

describe('판정 — 닫힌 묶음의 덮개', () => {
  it('깨끗한 닫힌 묶음은 문제 0 · 덮개 0', () => {
    const r = run(tree());
    expect(r.problems).toEqual([]);
    expect(r.overlays).toMatchObject({ found: 0, allowed: 0, lockedTests: 0 });
  });
  it('덮개 표시가 들어오면 실패하고 파일 · 줄 · 표시와 처방을 알려 준다(양성 대조)', () => {
    const r = run(tree({ [NEW]: WITH_OVERLAY }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('손으로 지은 덮개 2곳 더(명단 0곳)');
    expect(r.problems[0]).toContain(`${NEW}:1 fixed inset-0`);
    expect(r.problems[0]).toContain('lockedBy');
  });
  it('명단에 개수와 잠그는 시험이 맞게 올라 있으면 통과하고 인용한 시험 수를 센다', () => {
    const r = run(tree({ [NEW]: WITH_OVERLAY }), [ov(NEW, 2, [`${LOCK_FILE}::잠금 시험 하나`, `${LOCK_FILE}::잠금 시험 둘`])]);
    expect(r.problems).toEqual([]);
    expect(r.overlays).toMatchObject({ found: 2, allowed: 2, lockedTests: 2 });
  });
  it('명단 개수보다 덮개가 늘면(새로 하나 더) 실패한다', () => {
    const r = run(tree({ [NEW]: `${WITH_OVERLAY}export const C = () => <div className="fixed inset-0" />;\n` }), [ov(NEW, 2)]);
    expect(problemsOf(r)).toContain('손으로 지은 덮개 1곳 더(명단 2곳)');
  });
  it('명단 개수보다 덮개가 줄면(옮겨서 낡았다) 실패한다', () => {
    const r = run(tree({ [NEW]: WITH_OVERLAY }), [ov(NEW, 3)]);
    expect(problemsOf(r)).toContain('덮개 표시가 2곳뿐인데 3곳이라 적혀 있다');
  });
  it('덮개가 0인데 명단에 올라 있으면 낡은 항목으로 실패한다', () => {
    const r = run(tree(), [ov('components/one/f0.tsx', 1)]);
    expect(problemsOf(r)).toContain('덮개 표시가 0곳뿐인데 1곳이라 적혀 있다');
  });
  it('개수가 없거나 0 · 소수면 실패한다', () => {
    for (const count of [undefined, 0, 1.5, -1]) {
      const r = run(tree({ [NEW]: WITH_OVERLAY }), [ov(NEW, count)]);
      expect(problemsOf(r), String(count)).toContain('개수(count, 1 이상 정수)가 필요하다');
    }
  });
  it('까닭이 짧으면 실패한다(기존 규칙 그대로)', () => {
    const r = run(tree({ [NEW]: WITH_OVERLAY }), [ov(NEW, 2, undefined, '짧음')]);
    expect(problemsOf(r)).toContain('까닭(why)이 없거나 너무 짧다');
  });
  it('닫히지 않은 묶음의 파일을 덮개 예외로 올리면 실패하고, 열린 묶음은 덮개를 세지 않는다', () => {
    expect(problemsOf(run(tree({ [NEW]: WITH_OVERLAY }), [ov(NEW, 2)], OPEN))).toContain('닫힌 묶음(Group.closed)의 파일에만 올린다');
    const open = run(tree({ [NEW]: WITH_OVERLAY }), [], OPEN);
    expect(open.problems).toEqual([]);
    expect(open.overlays.closedFiles).toBe(0);
  });
  it('같은 파일에 덮개 항목이 둘이면 합이 맞아도 실패하고, 다른 종류와 한 항목에 섞어도 실패한다', () => {
    const files = tree({ [NEW]: WITH_OVERLAY });
    expect(problemsOf(run(files, [ov(NEW, 1), ov(NEW, 1)]))).toContain('덮개» 항목이 같은 파일에 둘 이상이다'.replace('덮개»', `${OVERLAY_KIND}»`));
    const mixed: ExceptionEntry = { file: NEW, kinds: [OVERLAY_KIND, RAW_KIND], why: REASON, count: 2, lockedBy: [`${LOCK_FILE}::잠금 시험 하나`] };
    expect(problemsOf(run(files, [mixed]))).toContain('다른 종류와 한 항목에 섞지 않는다');
  });
  it('날것 입력칸 항목과 덮개 항목은 같은 파일에 따로 올릴 수 있다(count가 종류마다 다르다)', () => {
    const both = 'export const B = () => <div className="fixed inset-0"><input /></div>;\n'; // 덮개 1 · 날것 1
    const r = run(tree({ [NEW]: both }), [ov(NEW, 1), { file: NEW, kinds: [RAW_KIND], why: REASON, count: 1 }]);
    expect(r.problems).toEqual([]);
  });
});

describe('판정 — 명단이 인용한 잠그는 시험(lockedBy)', () => {
  const files = () => tree({ [NEW]: WITH_OVERLAY });
  it('lockedBy가 없거나 비면 실패한다 — 까닭만으로 올리지 않는다', () => {
    for (const lockedBy of [null, [] as string[]]) {
      expect(problemsOf(run(files(), [ov(NEW, 2, lockedBy)])), String(lockedBy)).toContain('현재 동작을 잠그는 시험(lockedBy');
    }
  });
  it('인용한 시험 제목이 파일에 없으면 실패한다(이름이 바뀌었거나 지워졌다)', () => {
    expect(problemsOf(run(files(), [ov(NEW, 2, [`${LOCK_FILE}::없는 제목`])]))).toContain(`잠그는 시험 «없는 제목»을 «${LOCK_FILE}»에서 못 찾는다`);
  });
  it('인용한 시험이 skip이면 실패한다(꺼진 시험은 잠그지 못한다)', () => {
    expect(problemsOf(run(files(), [ov(NEW, 2, [`${LOCK_FILE}::꺼진 시험`])]))).toContain('못 찾는다');
  });
  it('인용한 시험 파일이 없으면 실패한다', () => {
    expect(problemsOf(run(files(), [ov(NEW, 2, ['components/one/gone.test.tsx::잠금 시험 하나'])]))).toContain('읽을 수 없다');
  });
  it('인용한 파일이 시험 파일이 아니면 · 꼴이 틀리면 실패한다', () => {
    expect(problemsOf(run(files(), [ov(NEW, 2, ['components/one/f0.tsx::잠금 시험 하나'])]))).toContain('시험 파일(.test.ts · .test.tsx)이 아니다');
    for (const bad of ['꼴이 없다', '::제목만', `${LOCK_FILE}::`]) {
      expect(problemsOf(run(files(), [ov(NEW, 2, [bad])])), bad).toContain("꼴이 '시험 파일::시험 제목'이 아니다");
    }
  });
  it('인용 경로가 src 밖으로 새거나(.. · 절대 경로 · . · 역슬래시) 상대 경로가 아니면 실패한다', () => {
    for (const bad of ['../outside.test.tsx', '/abs/x.test.tsx', 'components/../x.test.tsx', './x.test.tsx', 'components\\x.test.tsx']) {
      expect(problemsOf(run(files(), [ov(NEW, 2, [`${bad}::잠금 시험 하나`])])), bad).toContain('src 기준 상대 경로여야 한다');
    }
  });
  it('인용 시험 둘 중 하나만 없어도 실패하고, 있는 쪽만 인용 수에 센다', () => {
    const r = run(files(), [ov(NEW, 2, [`${LOCK_FILE}::잠금 시험 하나`, `${LOCK_FILE}::없는 제목`])]);
    expect(problemsOf(r)).toContain('못 찾는다');
    expect(r.overlays.lockedTests).toBe(1);
  });
  it('안 알려진 종류 안내에 덮개가 들어 있다', () => {
    const r = run(tree(), [{ file: 'components/one/f0.tsx', kinds: ['nope'], why: REASON }]);
    expect(problemsOf(r)).toContain(OVERLAY_KIND);
  });
});

// ---- 묶음 밖 덮개 기준선 ----
describe('판정 — 묶음 밖 덮개의 기준선(늘면 실패 · 줄면 허용)', () => {
  const OUT = 'lib/outside/panel.tsx';
  const runOut = (files: Record<string, string>, baseline: Record<string, number> = {}) => evaluate(mapReader(files), CLOSED, [], baseline);
  it('묶음 밖에 덮개가 없으면 문제 0 · 소스 전체를 훑었다고 센다', () => {
    const r = runOut(tree({ [OUT]: CLEAN }));
    expect(r.problems).toEqual([]);
    expect(r.outsideOverlays).toMatchObject({ found: 0, baseline: 0, shrunk: [] });
    expect(r.outsideOverlays.scannedFiles).toBeGreaterThan(0);
  });
  it('묶음 밖 새 덮개는 기준선이 없으면 실패하고 파일 · 줄을 알려 준다(양성 대조)', () => {
    const r = runOut(tree({ [OUT]: WITH_OVERLAY }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('묶음 밖 덮개 2곳 더(기준선 0곳)');
    expect(r.problems[0]).toContain(`${OUT}:1 fixed inset-0`);
  });
  it('기준선과 같으면 통과하고, 기준선보다 늘면(같은 파일에 하나 더) 실패한다', () => {
    expect(runOut(tree({ [OUT]: WITH_OVERLAY }), { [OUT]: 2 }).problems).toEqual([]);
    const more = runOut(tree({ [OUT]: `${WITH_OVERLAY}export const C = () => <div className="fixed inset-0" />;\n` }), { [OUT]: 2 });
    expect(problemsOf(more)).toContain('묶음 밖 덮개 1곳 더(기준선 2곳)');
  });
  it('기준선보다 줄면 통과하고 기준선을 내리라고 알린다(실패 아님)', () => {
    const r = runOut(tree({ [OUT]: 'export const D = () => <div className="fixed inset-0" />;\n' }), { [OUT]: 2 });
    expect(r.problems).toEqual([]);
    expect(r.outsideOverlays.shrunk).toEqual([`${OUT} (기준선 2곳 → 지금 1곳)`]);
    const gone = runOut(tree({ [OUT]: CLEAN }), { [OUT]: 2 });
    expect(gone.problems).toEqual([]);
    expect(gone.outsideOverlays.shrunk).toHaveLength(1);
  });
  it('기준선의 파일이 사라졌거나 묶음 안 파일이거나 개수가 틀리면 실패한다', () => {
    expect(problemsOf(runOut(tree(), { 'lib/outside/gone.tsx': 1 }))).toContain('그 파일이 없다');
    expect(problemsOf(runOut(tree({ [NEW]: WITH_OVERLAY }), { [NEW]: 2 }))).toContain('묶음 안의 파일이다');
    for (const n of [0, 1.5, -1]) expect(problemsOf(runOut(tree({ [OUT]: WITH_OVERLAY }), { [OUT]: n })), String(n)).toContain('개수(1 이상 정수)가 필요하다');
  });
  it('주석 속 언급만 있는 묶음 밖 파일은 안 걸린다', () => {
    const r = runOut(tree({ [OUT]: ['// 예전엔 fixed inset-0 에 role="dialog" 였다', '/* role="dialog" fixed inset-0 */', CLEAN].join('\n') }));
    expect(r.problems).toEqual([]);
    expect(r.outsideOverlays.found).toBe(0);
  });
  it('listAll이 없는 판독기는 이 검사를 건너뛴다(scannedFiles null)', () => {
    const base = mapReader(tree({ [OUT]: WITH_OVERLAY }));
    const r = evaluate({ list: base.list, read: base.read }, CLOSED, []);
    expect(r.outsideOverlays.scannedFiles).toBeNull();
    expect(r.problems).toEqual([]);
  });
});

describe('실제 소스 트리 — 묶음 밖 덮개 기준선', REAL, () => {
  const reader = cached(fsReader(SRC_ROOT));
  const baseline = loadOutsideOverlayBaseline(EXCEPTIONS_PATH);
  it('묶음 밖은 storage-view 한 파일 4표시뿐이고(기준선 1파일 4표시) 묶음 밖 문제는 0이다', () => {
    expect(baseline).toEqual({ 'components/storage/storage-view.tsx': 4 });
    const r = evaluate(reader, GROUPS, loadExceptions(EXCEPTIONS_PATH), baseline);
    expect(r.problems.filter((p) => p.includes('묶음 밖'))).toEqual([]);
    expect(r.outsideOverlays).toMatchObject({ found: 4, baseline: 4, shrunk: [] });
    expect(r.outsideOverlays.scannedFiles).toBeGreaterThan(900);
    expect(scanOverlays(reader.read('components/storage/storage-view.tsx')).map((m) => m.mark).sort()).toEqual(['fixed inset-0', 'fixed inset-0', 'role=dialog', 'role=dialog']);
  });
  it('주석에서만 덮개 표시를 언급하는 파일 넷은 안 걸리고, 다섯째(chats/layout)는 진짜 가림막 하나만 센다', () => {
    for (const f of ['components/desktop/phone-first-screen.tsx', 'components/shared/anchored-popover.tsx', 'components/ui/popover.tsx', 'lib/inner-layer-esc.ts']) {
      const text = reader.read(f);
      expect(/fixed\s+inset-0|role=["']dialog["']/.test(text), `${f}에 언급이 있다`).toBe(true); // 정규식이라면 걸렸을 파일 — 양성 대조
      expect(scanOverlays(text, f), f).toEqual([]);
    }
    const chats = reader.read('app/(authenticated)/chats/layout.tsx');
    expect(scanOverlays(chats, 'app/(authenticated)/chats/layout.tsx').map((m) => m.mark)).toEqual(['fixed inset-0']);
  });
  const patchOut = (target: string, extra: string) => ({ ...reader, read: (rel: string) => (rel === target ? `${reader.read(rel)}\n${extra}\n` : reader.read(rel)) });
  it('양성 대조: 묶음 밖 아무 파일(lib/utils.ts)에 덮개 문자열을 넣으면 빨개진다', () => {
    const a = evaluate(patchOut('lib/utils.ts', "export const BAD = 'fixed inset-0 z-50';"), GROUPS, loadExceptions(EXCEPTIONS_PATH), baseline);
    expect(problemsOf(a)).toContain('묶음 밖 덮개 1곳 더(기준선 0곳): lib/utils.ts');
  });
  it('양성 대조: 기준선에 오른 storage-view에 하나 더 넣어도 빨개진다', () => {
    const b = evaluate(patchOut('components/storage/storage-view.tsx', "export const BAD = <div role=\"dialog\" />;"), GROUPS, loadExceptions(EXCEPTIONS_PATH), baseline);
    expect(problemsOf(b)).toContain('묶음 밖 덮개 1곳 더(기준선 4곳): components/storage/storage-view.tsx');
  });
});

describe('실제 소스 트리 — 덮개 명단(아홉 묶음 안 14곳 = 명단 14곳, 모두 잠그는 시험을 인용)', REAL, () => {
  const reader = cached(fsReader(SRC_ROOT));
  const baseline = loadOutsideOverlayBaseline(EXCEPTIONS_PATH);
  const all = loadExceptions(EXCEPTIONS_PATH);
  const listed = all.filter((e) => e.kinds.includes(OVERLAY_KIND));
  const evalReal = (r = reader, ex: ExceptionEntry[] = all) => evaluate(r, GROUPS, ex, baseline);
  const patch = (target: string, fn: (text: string) => string) => ({ ...reader, read: (rel: string) => (rel === target ? fn(reader.read(rel)) : reader.read(rel)) });

  it('덮개는 명단 14곳(아홉 파일)뿐이고 문제 0이며 인용한 잠금 시험 전부가 실제로 있다', () => {
    const r = evalReal();
    expect(r.problems).toEqual([]);
    expect(r.overlays.found).toBe(14);
    expect(r.overlays.allowed).toBe(14);
    expect(listed).toHaveLength(9);
    expect(listed.reduce((n, e) => n + (e.count ?? 0), 0)).toBe(14);
    const cited = listed.reduce((n, e) => n + (e.lockedBy?.length ?? 0), 0);
    expect(r.overlays.lockedTests).toBe(cited); // 인용한 시험이 하나도 빠짐없이 «켜진 시험»으로 읽혔다
    expect(cited).toBeGreaterThanOrEqual(listed.length); // 항목마다 적어도 하나
    for (const e of listed) {
      expect(e.why.trim().length, e.file).toBeGreaterThanOrEqual(10);
      expect(e.lockedBy?.length ?? 0, e.file).toBeGreaterThanOrEqual(1);
    }
  });
  it('항목별 개수: 파일마다 도구가 센 표시 수와 명단이 같다(옛 인벤토리의 16곳에서 contextual-panel-layout 2곳이 빠진 모양)', () => {
    const expected: Record<string, number> = {
      'app/(authenticated)/chats/layout.tsx': 1,
      'components/chat/asset-picker-popover.tsx': 1,
      'components/chat/image-lightbox.tsx': 1,
      'components/kanban/story-detail-panel.tsx': 4,
      'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx': 2,
      'components/nav/notification-bell.tsx': 2,
      'components/support-widget/support-widget-launcher.tsx': 1,
      'components/ui/dialog.tsx': 1,
      'components/ui/sheet.tsx': 1,
    };
    expect(Object.fromEntries(listed.map((e) => [e.file, e.count]))).toEqual(expected);
    for (const [file, n] of Object.entries(expected)) expect(scanOverlays(reader.read(file), file), file).toHaveLength(n);
    expect(scanOverlays(reader.read('components/ui/contextual-panel-layout.tsx'), 'components/ui/contextual-panel-layout.tsx')).toEqual([]); // Sheet로 옮겼다
  });
  it('양성 대조: 명단에 없는 닫힌 파일에 덮개를 넣으면 빨개진다', () => {
    const a = evalReal(patch('components/ui/badge.tsx', (t) => `${t}\nexport const Bad = () => <div className="fixed inset-0 z-50" />;\n`));
    expect(problemsOf(a)).toContain('손으로 지은 덮개 1곳 더(명단 0곳): components/ui/badge.tsx');
  });
  it('양성 대조: 명단에 오른 파일에 하나 더 넣어도 빨개진다', () => {
    const b = evalReal(patch('components/support-widget/support-widget-launcher.tsx', (t) => `${t}\nexport const Bad = () => <div role="dialog" />;\n`));
    expect(problemsOf(b)).toContain('손으로 지은 덮개 1곳 더(명단 1곳): components/support-widget/support-widget-launcher.tsx');
  });
  it('양성 대조: 명단에서 한 항목(ui/sheet)을 빼면 새 덮개로 잡힌다', () => {
    const r = evalReal(reader, all.filter((e) => e.file !== 'components/ui/sheet.tsx'));
    expect(problemsOf(r)).toContain('손으로 지은 덮개 1곳 더(명단 0곳): components/ui/sheet.tsx');
  });
  const [lockFile, lockTitle] = (listed.find((e) => e.file === 'components/support-widget/support-widget-launcher.tsx')!.lockedBy![0]!).split('::') as [string, string];
  it('양성 대조: 인용한 시험의 이름이 바뀌면 빨개진다(까닭만 남고 잠금이 사라지는 것을 막는다)', () => {
    const renamed = evalReal(patch(lockFile, (t) => t.replace(lockTitle, `${lockTitle} (이름이 바뀜)`)));
    expect(problemsOf(renamed)).toContain(`잠그는 시험 «${lockTitle}»을 «${lockFile}»에서 못 찾는다`);
  });
  it('양성 대조: 인용한 시험이 it.skip으로 꺼지면 빨개진다', () => {
    const skipped = evalReal(patch(lockFile, (t) => t.replace(`it('${lockTitle}'`, `it.skip('${lockTitle}'`)));
    expect(problemsOf(skipped)).toContain('못 찾는다');
  });
  it('양성 대조: 인용한 시험 파일이 사라지면 빨개진다', () => {
    const gone = evalReal({ ...reader, read: (rel: string) => { if (rel === lockFile) throw new Error('ENOENT'); return reader.read(rel); } });
    expect(problemsOf(gone)).toContain(`lockedBy 시험 파일 «${lockFile}»을 읽을 수 없다`);
  });
  it('양성 대조: 이 PR이 옮긴 contextual-panel-layout에 손으로 지은 덮개를 되돌려 넣으면 빨개진다', () => {
    const r = evalReal(patch('components/ui/contextual-panel-layout.tsx', (t) => `${t}\nexport const Back = () => <div className="fixed inset-0 z-50" role="dialog" />;\n`));
    expect(problemsOf(r)).toContain('손으로 지은 덮개 2곳 더(명단 0곳): components/ui/contextual-panel-layout.tsx');
  });
});
