import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { baseFontPx, scanSource, scanTree, wrapperSizes } from './small-text-input-scan';
import { measureFsReads } from './test-utils/fs-work';

// story #4406 — 모바일 폭에서 글자가 16px 미만인 입력칸(iOS WebKit이 초점 때 화면을 확대)을 새로 만들지 않는다.
// 인증 전 · 첫 진입 화면은 0. 나머지 기존 자리는 파일별 수(baseline)로 줄기만 — 늘면 RED, 줄었으면 baseline도 줄일 것(stale도 RED).
// 고치는 모양: `text-base lg:text-sm`(모바일 16px · 데스크톱 무변 · md 금지 규칙에 맞춰 lg) 또는 공용 Input(기본 text-base).
const SRC_ROOT = path.resolve(__dirname, '../src');
const BASELINE: Record<string, number> = JSON.parse(readFileSync(path.join(__dirname, 'small-text-input-baseline.json'), 'utf8'));
const ZERO_PREFIXES = ['app/login/', 'app/register/', 'app/forgot-password/', 'app/reset-password/', 'app/invite/', 'app/onboarding/', 'app/mfa/'];

describe('scanSource — 셀프테스트', () => {
  it('양성 — 날 칸의 접두사 없는 text-sm · text-xs · 임의값 12px · 같은 파일 문자열 상수 · 공용 Input에 준 text-sm', () => {
    const src = `
      const inputCls = 'rounded px-2 text-sm';
      export const A = () => (<>
        <input className="w-full text-sm" />
        <textarea className={cn('p-2', 'text-xs')} />
        <select className="text-[12px]" />
        <input className={\`\${inputCls} ml-auto\`} />
        <Input className="text-sm" />
      </>);`;
    expect(scanSource(src, 'a.tsx').sites.map((s) => s.px)).toEqual([14, 12, 12, 14, 14]);
  });

  it('음성 — 모바일 16px(text-base lg:text-sm) · 공용 Input 기본 · 글자 입력 아닌 type · 크기 없는 날 칸(물려받음 · 따로 셈)', () => {
    const src = `
      export const B = () => (<>
        <input className="w-full text-base lg:text-sm" />
        <Input className="h-10" />
        <input type="checkbox" className="text-xs" />
        <input className="w-full" />
      </>);`;
    const r = scanSource(src, 'b.tsx');
    expect(r.sites).toEqual([]);
    expect(r.inherits).toBe(1);
  });

  it('상태에 따라 붙는 클래스(삼항)는 크기 판정에 안 섞는다', () => {
    const src = `export const C = ({ bad }) => <input className={\`w-full text-base lg:text-sm \${bad ? 'border-destructive text-xs' : 'border-border'}\`} />;`;
    expect(scanSource(src, 'c.tsx').sites).toEqual([]);
  });

  it('⭐공용 래퍼 호출부 — 래퍼 크기를 받는다 · 호출부가 크기를 덮으면 그 크기(PR 4807: onboarding-form의 OperatorInput 6칸)', () => {
    const src = `
      export const D = () => (<>
        <OperatorInput value={a} />
        <OperatorInput className="h-10 text-base lg:text-sm" />
        <OperatorTextarea className="text-xs" />
      </>);`;
    expect(scanSource(src, 'd.tsx', new Map([['OperatorInput', 14], ['OperatorTextarea', 16]])).sites.map((s) => [s.tag, s.px]))
      .toEqual([['OperatorInput', 14], ['OperatorTextarea', 12]]);
    expect(scanSource(src, 'd.tsx', new Map([['OperatorInput', 16], ['OperatorTextarea', 16]])).sites.map((s) => [s.tag, s.px]))
      .toEqual([['OperatorTextarea', 12]]);
  });

  it('래퍼 크기는 정의 파일에서 읽는다 — 정의가 없거나 입력칸을 안 그리면 던진다(표가 헛돌지 않게)', () => {
    const def = `const cls = 'px-3 text-sm'; export function OperatorInput(p) { return <Input className={cn(cls, p.className)} />; }
      export function OperatorTextarea(p) { return <textarea className={cn(cls, 'min-h-24')} />; }
      export function OperatorSelect(p) { return <select className={cn(cls)} />; }`;
    expect([...wrapperSizes(() => def)]).toEqual([['OperatorInput', 14], ['OperatorTextarea', 14], ['OperatorSelect', 14]]);
    expect(() => wrapperSizes(() => 'export const Nothing = 1;')).toThrow(/정의가/);
  });

  it('baseFontPx — 접두사 있는 크기(lg: · placeholder:)는 모바일 기본값이 아니다', () => {
    expect(baseFontPx('text-base lg:text-sm placeholder:text-xs')).toBe(16);
    expect(baseFontPx('md:text-sm')).toBeNull();
  });
});

describe('실 트리(apps/web/src)', () => {
  // 실 트리 전수라 행 가드(story #4333)를 넉넉히 — story #4408 표에서 같은 모양 스캔의 CI 최댓값이 6초대였다. 일의 양은 결정적으로 잰다.
  it('인증 전 · 첫 진입 화면은 0 · 나머지는 baseline과 파일별로 정확히 일치(신규 0 · stale 0)', () => {
    const { result, maxPerFile } = measureFsReads(() => scanTree(SRC_ROOT));
    expect(maxPerFile.count, `${maxPerFile.file} — 한 스캔에서 두 번 이상 읽음`).toBeLessThanOrEqual(1);
    const { perFile, sites, fileCount } = result;
    expect(fileCount).toBeGreaterThan(300);

    const zeroHits = sites.filter((s) => ZERO_PREFIXES.some((p) => s.file.startsWith(p)));
    expect(zeroHits.map((s) => `${s.file}:${s.line} <${s.tag}> ${s.px}px`), '인증 전 · 첫 진입 화면의 16px 미만 입력칸').toEqual([]);
    for (const file of Object.keys(BASELINE)) expect(ZERO_PREFIXES.some((p) => file.startsWith(p)), `${file} — 0이어야 하는 화면은 baseline에 못 둔다`).toBe(false);

    const grown = Object.entries(perFile).filter(([f, n]) => n > (BASELINE[f] ?? 0)).map(([f, n]) => `${f}: ${BASELINE[f] ?? 0} → ${n}`);
    expect(grown, '16px 미만 입력칸이 늘었다 — text-base lg:text-sm 또는 공용 Input으로').toEqual([]);
    const stale = Object.entries(BASELINE).filter(([f, n]) => (perFile[f] ?? 0) < n).map(([f, n]) => `${f}: ${n} → ${perFile[f] ?? 0}`);
    expect(stale, '줄었다 — small-text-input-baseline.json도 같이 줄일 것').toEqual([]);
  }, 30_000);
});
