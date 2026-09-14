/**
 * story #3826-pre 회귀가드 유닛 테스트(페드루 PO 지시, 2026-09-13 — 4254 rebase에 동봉).
 * PR #4255에서 손으로 확인한 뮤테이션 3건(초과 FAIL·미달 FAIL·일치 GREEN)을 `compareToBaseline`
 * 순수 함수에 직접 표본으로 고정한다 — 파일시스템 스캔(main()) 없이 결정적으로 재현.
 */
import { describe, expect, it } from 'vitest';
import { compareToBaseline, countAlphaTextForeground } from './verify-no-new-alpha-text-foreground';

describe('compareToBaseline — story #3826-pre 카디르 QA 뮤테이션 3건', () => {
  it('일치(baseline과 실측 개수가 정확히 같음) — 초과 0·stale 0 (GREEN)', () => {
    const baseline = new Map([['a.tsx::text-foreground/80', 2]]);
    const actual = new Map([['a.tsx::text-foreground/80', 2]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([]);
    expect(stale).toEqual([]);
  });

  // 카디르 지적 ① — 등재 항목을 solid로 고쳤는데 baseline 개수를 안 낮추면(실측이 등재값보다
  // 적음) stale로 잡혀야 한다(예전 Set 버전은 이걸 "경고"로만 두고 통과시켰다).
  it('미달(고쳤는데 baseline을 안 낮춤) — stale 1건 (FAIL)', () => {
    const baseline = new Map([['a.tsx::text-foreground/70', 1]]);
    const actual = new Map<string, number>(); // 코드에서 완전히 제거됨(실측 0).
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([]);
    expect(stale).toEqual([{ key: 'a.tsx::text-foreground/70', expected: 1, got: 0 }]);
  });

  // 카디르 지적 ② — 같은 파일·같은 토큰이 baseline보다 더 늘어나면(예: login/page.tsx의
  // text-foreground/80이 1곳 더 늘어 2곳) 증가로 잡혀야 한다(예전 Set 버전은 키 존재만
  // 보고 개수 증가를 못 잡았다).
  it('초과(같은 파일·같은 토큰이 baseline보다 더 늘어남) — increased 1건 (FAIL)', () => {
    const baseline = new Map([['app/login/page.tsx::text-foreground/80', 1]]);
    const actual = new Map([['app/login/page.tsx::text-foreground/80', 2]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([{ key: 'app/login/page.tsx::text-foreground/80', expected: 1, got: 2 }]);
    expect(stale).toEqual([]);
  });

  it('baseline에 없는 완전 신규 키가 실측에 나타나면 increased로 잡힌다', () => {
    const baseline = new Map<string, number>();
    const actual = new Map([['new-file.tsx::text-foreground/55', 1]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([{ key: 'new-file.tsx::text-foreground/55', expected: 0, got: 1 }]);
    expect(stale).toEqual([]);
  });
});

describe('countAlphaTextForeground — 주석 제외·동일 토큰 다중 발생', () => {
  it('같은 파일 안 동일 토큰 2회 발생을 정확히 카운트한다(Set dedupe 금지 — 카디르 지적 ②의 근본)', () => {
    const content = `
      <a className="text-foreground/80">one</a>
      <b className="text-foreground/80">two</b>
    `;
    const counts = countAlphaTextForeground(content, 'sample.tsx');
    expect(counts.get('sample.tsx::text-foreground/80')).toBe(2);
  });

  it('주석 속 문서화 문자열은 카운트하지 않는다(story #3716 관례)', () => {
    const content = `
      // 3826-pre — text-foreground/60(알파 합성) → solid text-muted-foreground.
      <a className="text-muted-foreground">fixed</a>
    `;
    const counts = countAlphaTextForeground(content, 'sample.tsx');
    expect(counts.size).toBe(0);
  });
});
