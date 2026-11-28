// story 5048 ③d — 박힌 디자인 값 래칫: 측정(분류별로 정확히 세는가) · 비교(늘면 RED · strict 분류는 줄어도 RED) · 실 저장소(기준선과 일치) · 되돌리면 RED.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, measureContent, measureTree } from './hardcoded-design-values';
import { compareToBaseline, loadBaseline } from './verify-no-hardcoded-design-values';

const only = (counts: Record<string, number>, id: string) => Object.fromEntries(Object.entries(counts).filter(([k, v]) => v > 0 && k !== id));

describe('측정 — 분류마다 박힌 값만 정확히 센다', () => {
  const cases: Array<[string, string]> = [
    ['arbitrary-size', '<div className="h-[15px] w-[280px] sm:min-h-[44px] -mt-[3px] p-[7px]" />'],
    ['arbitrary-text-size', '<p className="text-[13px] lg:text-[0.8rem]" />'],
    ['arbitrary-radius', '<div className="rounded-[10px] rounded-t-[6px]" />'],
    ['direct-shadow', '<div className="shadow-sm hover:shadow-lg shadow-[0_1px_2px_#000]" />'],
    ['old-alias-color', '<div className="bg-primary text-muted-foreground border-border bg-proof-blue-soft" />'],
    ['editorial-text', '<span className="text-editorial-ui text-editorial-meta" />'],
    ['inline-style-px', "<div style={{ width: 280, minHeight: '44px', padding: 12 }} />"],
  ];
  it.each(cases)('%s — 박힌 클래스를 센다(그 분류에만)', (id, src) => {
    const n = measureContent(src);
    expect(n[id], `${id}: ${JSON.stringify(n)}`).toBeGreaterThan(0);
    // 다른 분류는 (겹치는 예외 없이) 0 — 단, 옛 별칭 색은 다른 분류의 클래스와 겹쳐 걸릴 수 있다
    if (id !== 'old-alias-color') expect(only(n, id)).toEqual({});
  });

  it('ds 토큰 · 간격 단계 · 키트 글자 크기는 0 — `w-70` · `min-h-ds-touch` · `bg-ds-surface-sunk` · `text-xs` · `rounded-ds-control`', () => {
    const n = measureContent('<div className="w-70 min-h-ds-touch bg-ds-surface-sunk text-xs rounded-ds-control border-ds-line text-ds-ink-2 p-4 gap-3 shadow-none" />');
    expect(Object.values(n).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('주석 속 클래스 이름은 세지 않는다', () => {
    const n = measureContent('// w-[15px] bg-muted/40\n/* text-[13px] shadow-sm */\n<div className="p-4" />');
    expect(Object.values(n).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('비교 — 늘면 RED · strict 분류는 줄어도 RED · 큰 수 분류는 줄면 경고만', () => {
  const base = Object.fromEntries(CATEGORIES.map((c) => [c.id, 10]));
  it('같으면 초록', () => {
    expect(compareToBaseline(base, base)).toEqual({ increased: [], stale: [], slack: [] });
  });
  it('⭐strict 분류가 하나라도 늘면 increased(RED)', () => {
    const r = compareToBaseline({ ...base, 'arbitrary-size': 11 }, base);
    expect(r.increased.map((d) => d.id)).toEqual(['arbitrary-size']);
  });
  it('⭐옛 별칭 색 «새 사용»도 늘면 RED(큰 수 분류도 늘어남은 막음)', () => {
    const r = compareToBaseline({ ...base, 'old-alias-color': 11 }, base);
    expect(r.increased.map((d) => d.id)).toEqual(['old-alias-color']);
  });
  it('strict 분류가 줄면 stale(RED — 기준선을 같이 줄일 것)', () => {
    const r = compareToBaseline({ ...base, 'arbitrary-radius': 9 }, base);
    expect(r.stale.map((d) => d.id)).toEqual(['arbitrary-radius']);
  });
  it('큰 수 분류(옛 별칭 색 · 작은 글자 정의)가 줄면 slack(경고만)', () => {
    const r = compareToBaseline({ ...base, 'old-alias-color': 9, 'editorial-text': 9 }, base);
    expect(r.stale).toEqual([]);
    expect(r.slack.map((d) => d.id).sort()).toEqual(['editorial-text', 'old-alias-color']);
  });
  it('기준선에 없는 분류는 increased(몰래 새 분류가 못 들어옴)', () => {
    const { 'inline-style-px': _omit, ...partial } = base;
    expect(compareToBaseline(base, partial).increased.map((d) => d.id)).toEqual(['inline-style-px']);
  });
});

describe('실 저장소 — 지금 src가 기준선과 같다 · 되돌리면 RED', () => {
  const actual = measureTree(path.resolve(__dirname, '../src'));
  const baseline = loadBaseline();
  it('⭐새 박힌 값 0 · strict 분류는 기준선과 정확히 일치', () => {
    const r = compareToBaseline(actual, baseline);
    expect({ increased: r.increased, stale: r.stale }).toEqual({ increased: [], stale: [] });
  });
  it('⭐되돌리기 시뮬레이션: 박힌 값 하나가 새로 들어오면 그 분류가 increased', () => {
    // 기준선 «위로» 하나 — 실측 + 1이 아니다. 큰 수 분류(옛 별칭 색 · 편집체)는 다른 PR이 수를 줄이면 실측 < 기준선이 되는데(경고만 · 기준선은 다음 정리 때),
    // 그때 «실측 + 1»은 기준선과 같아져 increased가 아니게 된다(6063: 옛 Alert를 걷어 old-alias-color 6097 → 6093 → 이 시험이 빨개짐). 비교 논리는 기준선 기준이다.
    for (const c of CATEGORIES) {
      const r = compareToBaseline({ ...actual, [c.id]: (baseline[c.id] ?? 0) + 1 }, baseline);
      expect(r.increased.map((d) => d.id), c.id).toContain(c.id);
    }
  });
});
