import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { baseFontPx, beforeResponsive, desktopFontPx, scanSource, scanTree, wrapperSizes } from './small-text-input-scan';
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

  // 유나 4807 실측 표 그대로: shadcn Input 밑단(text-base md:text-sm) ← 래퍼 ← 호출부, 세 겹을 cn()으로 합친 값.
  const INPUT_BASE = 'h-9 px-3 text-base md:text-sm';
  const RESPONSIVE = 'flex w-full px-3 text-base lg:text-sm';
  const inputWrapper = { inner: INPUT_BASE, classes: `${RESPONSIVE} h-10`, px: 16 };
  const textareaWrapper = { inner: '', classes: `${RESPONSIVE} min-h-[96px]`, px: 16 };

  it('⭐공용 래퍼 호출부 — 밑단 · 래퍼 · 호출부를 cn()으로 합친 최종값으로 판정(PR 4807: onboarding-form의 OperatorInput 6칸)', () => {
    const src = `export const D = () => (<><OperatorInput value={a} /><OperatorInput className="h-10" /></>);`;
    const small = new Map([['OperatorInput', { inner: INPUT_BASE, classes: 'flex w-full px-3 text-sm h-10', px: 14 }]]);
    expect(scanSource(src, 'd.tsx', small).sites.map((s) => s.px)).toEqual([14, 14]);
    const r = scanSource(src, 'd.tsx', new Map([['OperatorInput', inputWrapper]]));
    expect([r.sites, r.drift]).toEqual([[], []]);
  });

  it.each([
    // [설명, 래퍼, 호출부 className, 모바일 px(16 미만일 때만 셈), 데스크톱 바뀜]
    ['입력칸(shadcn 밑단) · 호출부 text-xs — 모바일 12 · 데스크톱 14 그대로(md:text-sm이 남음)', 'input', 'min-w-0 flex-1 font-mono text-xs', 12, null],
    ['입력칸 · 호출부 크기 뺌 — 모바일 16 · 데스크톱 14 그대로(맞는 처방)', 'input', 'min-w-0 flex-1 font-mono', null, null],
    ['textarea(밑단 없음) · 호출부 text-xs — 모바일 12 · 데스크톱 12 → 14(래퍼 lg:text-sm이 남음)', 'textarea', 'min-h-[52px] text-xs', 12, [12, 14]],
    ['textarea · 호출부 text-base lg:text-xs — 모바일 16 · 데스크톱 12 그대로(맞는 처방)', 'textarea', 'min-h-[52px] text-base lg:text-xs', null, null],
  ] as const)('⭐%s', (_name, kind, own, mobile, drift) => {
    const tag = kind === 'input' ? 'OperatorInput' : 'OperatorTextarea';
    const r = scanSource(`export const X = () => <${tag} className="${own}" />;`, 'x.tsx', new Map([[tag, kind === 'input' ? inputWrapper : textareaWrapper]]));
    expect(r.sites.map((s) => s.px)).toEqual(mobile === null ? [] : [mobile]);
    expect(r.drift.map((d) => [d.intendedPx, d.mergedPx])).toEqual(drift === null ? [] : [drift]);
  });

  it('⭐호출부가 크기 주는 래퍼(story #4410 · EntityAwareTextarea) — 호출부 크기로 판정 · 크기 없는 호출은 세지 않음', () => {
    const wrappers = new Map([['EntityAwareTextarea', { inner: '', classes: '', px: null }]]);
    const src = `export const G = () => (<>
      <EntityAwareTextarea className="w-full font-mono text-sm" />
      <EntityAwareTextarea className="w-full font-mono text-base lg:text-sm" />
      <EntityAwareTextarea value={v} />
    </>);`;
    const r = scanSource(src, 'g.tsx', wrappers);
    expect(r.sites.map((x) => [x.tag, x.px])).toEqual([['EntityAwareTextarea', 14]]);
    expect(r.drift).toEqual([]);
  });

  it('beforeResponsive · desktopFontPx — 래퍼를 반응형으로 바꾸기 전 모양 · 1024px 이상 크기(lg → md → 접두사 없음)', () => {
    expect(beforeResponsive('flex text-base lg:text-sm h-10')).toBe('flex h-10 text-sm');
    expect(beforeResponsive('flex text-sm')).toBe('flex text-sm');
    expect(desktopFontPx('md:text-sm lg:text-sm text-xs')).toBe(14);
    expect(desktopFontPx('md:text-sm text-xs')).toBe(14);
    expect(desktopFontPx('lg:text-sm text-xs')).toBe(14);
    expect(desktopFontPx('text-xs')).toBe(12);
  });

  it('래퍼 크기는 정의 파일(과 밑단 공용 부품)에서 읽는다 — 정의가 없거나 입력칸을 안 그리면 던진다(표가 헛돌지 않게)', () => {
    const files: Record<string, string> = {
      'components/ui/operator-control.tsx': `const cls = 'px-3 text-sm'; export function OperatorInput(p) { return <Input className={cn(cls, p.className)} />; }
        export function OperatorTextarea(p) { return <textarea className={cn(cls, 'min-h-24')} />; }
        export function OperatorSelect(p) { return <select className={cn(cls)} />; }`,
      'components/ui/input.tsx': `function Input({ className }) { return <InputPrimitive className={cn('h-9 text-base md:text-sm', className)} />; }`,
      'components/shared/entity-aware-textarea.tsx': `export function EntityAwareTextarea({ className }) { return <div className="relative"><textarea className={className} /></div>; }`,
    };
    const w = wrapperSizes((rel) => files[rel]!);
    expect([...w].map(([n, i]) => [n, i.inner, i.px])).toEqual([
      ['OperatorInput', 'h-9 text-base md:text-sm', 14], ['OperatorTextarea', '', 14], ['OperatorSelect', '', 14],
      ['EntityAwareTextarea', '', null],
    ]);
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
    const { perFile, sites, fileCount, drift } = result;
    expect(drift.map((d) => `${d.file}:${d.line} <${d.tag}> 데스크톱 ${d.intendedPx} → ${d.mergedPx}px`), '래퍼와 합쳐져 데스크톱 크기가 바뀐 호출부 — text-base lg:text-<원래 크기>로').toEqual([]);
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
