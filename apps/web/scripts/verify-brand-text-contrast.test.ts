import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBrandTextContrasts, findBrandOnTextUses, findBrandSoftTextUses, scanRepo, scanRepoBrandOnText } from './verify-brand-text-contrast';

const CSS = readFileSync(path.resolve(__dirname, '../src/app/globals.css'), 'utf8');

describe('story #4315 — 브랜드 글자 토큰 대비', () => {
  it('⭐양 테마 --brand-text가 배경 · 카드 · 칩 틴트에서 4.5:1 이상(기대값 pin)', () => {
    const [light, dark] = computeBrandTextContrasts(CSS);
    expect(light!.onBackground).toBeCloseTo(7.05, 1);
    expect(dark!.onBackground).toBeCloseTo(10.48, 1);
    for (const c of [light!, dark!]) {
      expect(c.onBackground).toBeGreaterThanOrEqual(4.5);
      expect(c.onCard).toBeGreaterThanOrEqual(4.5);
      expect(c.onChipTint).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('양성대조 — 밝은 테마 글자가 brand-soft였다면 1.25로 FAIL(예전 모양)', () => {
    const regressed = CSS.replace('--brand-text: var(--brand-strong);', '--brand-text: var(--brand-soft);');
    expect(regressed).not.toBe(CSS);
    const [light] = computeBrandTextContrasts(regressed);
    expect(light!.onBackground).toBeCloseTo(1.25, 1);
    expect(light!.onBackground).toBeLessThan(4.5);
  });

  it('양성대조 — 어두운 테마를 brand-strong으로 바꾸면(3.92) FAIL — 테마마다 다른 토큰이어야 한다', () => {
    const regressed = CSS.replace('--brand-text: var(--brand-soft);', '--brand-text: var(--brand-strong);');
    expect(regressed).not.toBe(CSS);
    const [, dark] = computeBrandTextContrasts(regressed);
    expect(dark!.onBackground).toBeLessThan(4.5);
  });
});

describe('story #4315 — brand-soft 글자색 사용처', () => {
  const count = (src: string, file = 'x.tsx') => findBrandSoftTextUses(src, file).length;

  it('양성 — 글자색 모양 셋(유틸 · 임의값 · 변형 사슬 · CSS)', () => {
    expect(count("<a className=\"text-brand-soft underline\" />")).toBe(1);
    expect(count("const c = 'bg-brand/14 text-[color:var(--brand-soft)]';")).toBe(1);
    expect(count("'[&_a]:text-brand-soft [&_a]:underline'")).toBe(1);
    expect(count("<span className=\"hover:text-brand-soft\" />")).toBe(1);
    expect(count('.link { color: var(--brand-soft); }', 'x.css')).toBe(1);
  });

  it('음성 — 틴트(bg · border) · dark: 전용 · 새 토큰 · 이름만 비슷한 것', () => {
    expect(count("<div className=\"bg-brand-soft border-brand-soft\" />")).toBe(0);
    expect(count("<a className=\"text-brand-text dark:text-brand-soft\" />")).toBe(0);
    expect(count("<a className=\"text-brand-text\" />")).toBe(0);
    expect(count("<a className=\"text-brand-soft-x\" />")).toBe(0);
    expect(count('.chip { background-color: var(--brand-soft); }', 'x.css')).toBe(0);
  });

  it('⭐실 저장소 — brand-soft 글자색 0(dark: 전용 제외)', () => {
    expect(scanRepo(path.resolve(__dirname, '../src'))).toEqual([]);
  });
});

describe('story #4318 — text-brand를 글자에(AST)', () => {
  const LUCIDE = "import { Check, Play } from 'lucide-react';\n";
  const count = (src: string) => findBrandOnTextUses(LUCIDE + src, 'x.tsx').length;

  it('양성 — 링크 · 라벨 · cn 조건 · 틴트 칩 위 글자 · 식으로 넣은 글자', () => {
    expect(count('const a = <Link href="/login" className="font-medium text-brand hover:text-brand/80">로그인</Link>;')).toBe(1);
    expect(count("const a = <span className={cn('text-[11px]', on ? 'bg-brand/10 text-brand' : 'text-muted-foreground')}>{label}</span>;")).toBe(1);
    expect(count('const a = <div className="text-xs text-brand">{t(\'planLabel\')}</div>;')).toBe(1);
    expect(count("const c = cn('text-brand');")).toBe(1); // className 밖 — 요소를 모름
  });

  it('⭐양성 — aria-hidden이어도 안에 본문 글자가 있으면 잡는다(PO 4318: 장식 글리프만 허용)', () => {
    expect(count('const a = <span aria-hidden className="text-brand"><a href="/terms">이용약관</a></span>;')).toBe(1);
    expect(count('const a = <span aria-hidden="true" className="text-brand">{label}</span>;')).toBe(1);
    expect(count('const a = <span aria-hidden className="text-brand">→ 3</span>;')).toBe(1);
  });

  it('양성 — 장식 글리프인데 aria-hidden이 없으면 잡는다', () => {
    expect(count('const a = <span className="font-bold text-brand">→</span>;')).toBe(1);
  });

  it('음성 — 아이콘 · 로고 · 아이콘만 감싼 요소 · aria-hidden 장식 글리프 · dark: 전용 · 새 토큰', () => {
    expect(count('const a = <Check className="h-4 w-4 text-brand" />;')).toBe(0);
    expect(count('const a = <SprintableLogo className="text-brand dark:text-white" />;')).toBe(0);
    expect(count('const a = <span className="rounded-full text-brand"><Play className="size-4" /></span>;')).toBe(0);
    expect(count('const a = <div className="text-brand">{on && <Check className="size-3" />}</div>;')).toBe(0);
    expect(count('const a = <span className="font-bold text-brand" aria-hidden>→</span>;')).toBe(0);
    expect(count('const a = <span aria-hidden="true" className="text-xs text-brand">↗</span>;')).toBe(0);
    expect(count('const a = <a className="text-brand-text dark:text-brand">링크</a>;')).toBe(0);
    expect(count('const a = <a className="text-brand-text hover:text-brand-text/85">링크</a>;')).toBe(0);
  });

  it('음성 — aria-hidden={false}는 허용 근거가 아니다', () => {
    expect(count('const a = <span aria-hidden={false} className="text-brand">→</span>;')).toBe(1);
  });

  it('⭐실 저장소 — text-brand 글자 사용처 0', () => {
    expect(scanRepoBrandOnText(path.resolve(__dirname, '../src'))).toEqual([]);
  });
});
