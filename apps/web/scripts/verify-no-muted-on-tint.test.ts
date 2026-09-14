/**
 * story #3839(critical·2pt) 회귀가드 유닛 테스트 — no-new-alpha-text-foreground.test.ts와
 * 동형(카디르 QA 지적 관례): compareToBaseline 뮤테이션 표본(일치·초과·stale) + scanContent
 * JSX 검출 표본(같은 요소·깊은 자식·bg-muted 예외·조상 없음 예외) + activation-checklist-
 * banner.tsx 실사고를 그대로 본뜬 뮤테이션 1(한 곳 되돌리면 RED, AC2).
 */
import { describe, expect, it } from 'vitest';
import { compareToBaseline, scanContent } from './verify-no-muted-on-tint';

describe('compareToBaseline — story #3839', () => {
  it('일치(baseline과 실측 개수가 정확히 같음) — 초과 0·stale 0 (GREEN)', () => {
    const baseline = new Map([['a.tsx::muted-on-info-tint', 2]]);
    const actual = new Map([['a.tsx::muted-on-info-tint', 2]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('미달(고쳤는데 baseline을 안 낮춤) — stale 1건 (FAIL)', () => {
    const baseline = new Map([['a.tsx::muted-on-warning-tint', 1]]);
    const actual = new Map<string, number>();
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([]);
    expect(stale).toEqual([{ key: 'a.tsx::muted-on-warning-tint', expected: 1, got: 0 }]);
  });

  it('초과(같은 파일·같은 조합이 baseline보다 더 늘어남) — increased 1건 (FAIL)', () => {
    const baseline = new Map([['b.tsx::muted-on-destructive-tint', 1]]);
    const actual = new Map([['b.tsx::muted-on-destructive-tint', 2]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([{ key: 'b.tsx::muted-on-destructive-tint', expected: 1, got: 2 }]);
    expect(stale).toEqual([]);
  });

  it('baseline에 없는 완전 신규 키가 실측에 나타나면 increased로 잡힌다', () => {
    const baseline = new Map<string, number>();
    const actual = new Map([['new-file.tsx::muted-on-success-tint', 1]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([{ key: 'new-file.tsx::muted-on-success-tint', expected: 0, got: 1 }]);
    expect(stale).toEqual([]);
  });
});

describe('scanContent — JSX 구조 검출', () => {
  it('조상 tint(bg-info-tint) 서브트리 안 text-muted-foreground를 잡는다(깊은 자식)', () => {
    const content = `
      <Alert variant="info" className="bg-info-tint">
        <ul>
          <li className="text-muted-foreground">아직 안 함</li>
        </ul>
      </Alert>
    `;
    const violations = scanContent(content, 'sample.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });

  it('같은 요소가 bg-{family}-tint와 text-muted-foreground를 동시에 가지면 잡는다', () => {
    const content = `<div className="bg-warning-tint text-muted-foreground">경고</div>`;
    const violations = scanContent(content, 'sample.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('warning');
  });

  it('bg-muted 자체는 대상 밖(--muted-foreground의 calibrated 원래 짝)', () => {
    const content = `
      <div className="bg-muted">
        <p className="text-muted-foreground">본문</p>
      </div>
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  it('tint 조상이 없으면(일반 배경) text-muted-foreground를 잡지 않는다', () => {
    const content = `<p className="text-muted-foreground">그냥 본문</p>`;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  it('tint 조상 서브트리라도 text-foreground는 잡지 않는다(정상)', () => {
    const content = `
      <Alert variant="info" className="bg-info-tint">
        <p className="text-foreground">정상 문구</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });
});

// story #3839 AC2 — activation-checklist-banner.tsx 실사고(PR #4259) 그대로 본뜬 뮤테이션.
// 고쳐진 형태(met 무관 text-foreground 고정)는 0건이어야 하고, 그중 한 곳을 되돌리면(met일
// 때만 text-foreground, 아니면 text-muted-foreground) 그 자리가 즉시 RED로 잡혀야 한다 —
// 이 가드가 실제로 막던 결함을 되살렸을 때 정말 걸리는지 실측한다.
describe('scanContent — 뮤테이션 1(activation-checklist-banner.tsx 실사고 재현)', () => {
  const fixed = `
    <Alert variant="info" className="bg-info-tint">
      <ul>
        <li className={cn('flex items-center gap-1.5 text-sm', 'text-foreground')}>
          <CircleCheck />
          <span>완료 항목</span>
        </li>
      </ul>
    </Alert>
  `;

  it('고쳐진 형태(met 무관 text-foreground) — 위반 0건', () => {
    expect(scanContent(fixed, 'activation-checklist-banner.tsx')).toEqual([]);
  });

  it('한 곳을 met ? text-foreground : text-muted-foreground로 되돌리면 RED', () => {
    const mutated = fixed.replace(
      "'text-foreground')}",
      "met ? 'text-foreground' : 'text-muted-foreground')}",
    );
    const violations = scanContent(mutated, 'activation-checklist-banner.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });
});
