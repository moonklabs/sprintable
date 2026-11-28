// story 5048 ③d — 박힌 디자인 값 래칫: 측정(분류별로 정확히 세는가) · 비교(늘면 RED · strict 분류는 줄어도 RED) · 실 저장소(기준선과 일치) · 되돌리면 RED.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, measureContent, measureTree } from './hardcoded-design-values';
import { compareToBaseline, loadBaseline, slackLine } from './verify-no-hardcoded-design-values';

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
    ['hand-drawn-alert', '<p role="alert" className="text-sm">실패</p>'],
    ['ui-alert-destructive', '<Alert variant="destructive"><AlertDescription>실패</AlertDescription></Alert>'],
    ['text-only-loading', "<p className=\"text-sm\">{t('loading')}</p>"],
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

  it('⭐상태 모양 분류는 여러 줄로 쓴 태그 · `=>`가 든 속성 · 두 겹 중괄호도 센다(한 줄 꼴만 보지 않는다 — PO 11-28)', () => {
    const multi = `<div
      className="flex"
      onClick={() => go({ a: 1 })}
      style={{ width: 1 }}
      role="alert"
    >x</div>`;
    expect(measureContent(multi)['hand-drawn-alert']).toBe(1);
    const alert2 = `<Alert
      className="mb-2"
      variant="destructive"
    ><AlertDescription>x</AlertDescription></Alert>`;
    expect(measureContent(alert2)['ui-alert-destructive']).toBe(1);
    const load2 = `<p
      className="text-sm text-muted-foreground"
    >
      {t('loading')}
    </p>`;
    expect(measureContent(load2)['text-only-loading']).toBe(1);
  });

  it('⭐값을 달리 써도 센다 — role={\'alert\'} · role=\'alert\' · variant={"destructive"} · t("loading") · 앞 속성에 `>` 든 따옴표 문자열(codex)', () => {
    for (const src of [
      "<p role={'alert'}>x</p>", "<span role='alert'>x</span>", '<div title="a > b" role="alert">x</div>', '<div role={`alert`}>x</div>',
    ]) expect(measureContent(src)['hand-drawn-alert'], src).toBe(1);
    for (const src of ['<Alert variant={"destructive"}>x</Alert>', "<Alert variant='destructive'>x</Alert>", '<Alert title="a > b" variant="destructive">x</Alert>']) {
      expect(measureContent(src)['ui-alert-destructive'], src).toBe(1);
    }
    for (const src of ['<p>{t("loading")}</p>', "<p>{ tc( 'loading' ) }</p>", '<p title="a > b">{t(\'loading\')}</p>']) {
      expect(measureContent(src)['text-only-loading'], src).toBe(1);
    }
  });

  it('⭐`=` 둘레 공백 · `tCommon(...)` · 백틱 · `t (…)` 도 센다(codex 2차)', () => {
    expect(measureContent("<p role = {'alert'}>x</p>")['hand-drawn-alert']).toBe(1);
    expect(measureContent('<Alert variant = "destructive">x</Alert>')['ui-alert-destructive']).toBe(1);
    for (const src of ["<p>{tCommon('loading')}</p>", '<p>{t(`loading`)}</p>', "<p>{t ('loading')}</p>", "<p>{tc( \"loading\" )}</p>"]) {
      expect(measureContent(src)['text-only-loading'], src).toBe(1);
    }
  });

  // 알려진 빈틈(codex 2차 · 래칫이라 «새로 안 늘림»만 지킨다): `Alert`를 다른 이름으로 가져온 것(`<UiAlert>`) · 문자열/템플릿 안의 마크업(`'<p role="alert">'`)은 이름 · 문자 그대로만 본다.
  it('⭐비슷하지만 다른 것은 안 센다 — data-role · aria-role · data-variant · <p-card> · <Alerts> · 속성 이름 끝이 role인 것', () => {
    for (const src of [
      '<p data-role="alert">x</p>', '<p aria-role="alert">x</p>', '<p-card role="alert">x</p-card>', '<div xrole="alert">x</div>',
    ]) expect(measureContent(src)['hand-drawn-alert'], src).toBe(0);
    for (const src of ['<Alert data-variant="destructive">x</Alert>', '<Alerts variant="destructive">x</Alerts>']) {
      expect(measureContent(src)['ui-alert-destructive'], src).toBe(0);
    }
    expect(measureContent("<p-label>{t('loading')}</p-label>")['text-only-loading']).toBe(0);
  });

  it('크게 어긋난 입력에서도 끝없이 되짚지 않는다(되짚기 폭주 0) — 속성 오만 개 · 닫히지 않은 따옴표', () => {
    const t0 = Date.now();
    measureContent('<div ' + 'a="b" '.repeat(50_000));
    measureContent('<p ' + "x='y " .repeat(20_000));
    measureContent('<div ' + '{a:{b:1}} '.repeat(30_000));
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 6000);

  it('⭐옮긴 모양은 안 센다 — ErrorState · Banner · SkeletonGroup · 버튼 안 «불러오는 중…» · 알림이 아닌 role', () => {
    const moved = `<ErrorState title="x" /><Banner tone="failed">x</Banner><SkeletonGroup label={t('loading')} />
      <button>{t('loading')}</button><p role="status">x</p><div role="alertdialog">x</div><span>{t('loading')}</span>`;
    const n = measureContent(moved);
    expect([n['hand-drawn-alert'], n['ui-alert-destructive'], n['text-only-loading']]).toEqual([0, 0, 0]);
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
  it('⭐줄었을 때 verify가 찍는 한 줄은 «기준선을 N으로 내릴 수 있음»(N = 실측)이다', () => {
    const line = slackLine({ id: 'old-alias-color', baseline: 6097, actual: 6084 });
    expect(line).toContain('기준선을 6084으로 내릴 수 있음');
    expect(line).toContain('old-alias-color');
    expect(line).toContain('6097');
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
