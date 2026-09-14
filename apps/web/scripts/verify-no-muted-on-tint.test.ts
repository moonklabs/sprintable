/**
 * story #3839(critical·2pt) 회귀가드 유닛 테스트 — no-new-alpha-text-foreground.test.ts와
 * 동형(카디르 QA 지적 관례): compareToBaseline 뮤테이션 표본(일치·초과·stale) + scanContent
 * JSX 검출 표본(같은 요소·깊은 자식·bg-muted 예외·조상 없음 예외) + cva variant 컴포넌트
 * 경계(카디르 QA 보강, 2026-09-14 05:30Z) + activation-checklist-banner.tsx **실 파일**
 * 문자열 치환 뮤테이션(AC2 — 합성 표본은 보조, 실 파일이 주 판정).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildComponentTintMap,
  compareToBaseline,
  extractCvaTintVariants,
  scanContent,
  type ComponentTintMap,
} from './verify-no-muted-on-tint';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const UI_DIR = path.join(SRC_ROOT, 'components/ui');

describe('compareToBaseline — story #3839', () => {
  it('일치(baseline과 실측 개수가 정확히 같음) — 초과 0·stale 0 (GREEN)', () => {
    const baseline = new Map([['a.tsx::muted-on-info-tint', 2]]);
    const actual = new Map([['a.tsx::muted-on-info-tint', 2]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([]);
    expect(stale).toEqual([]);
  });

  // 카디르 지적 ① — 등재 항목을 고쳤는데 baseline 개수를 안 낮추면(실측이 등재값보다 적음)
  // stale로 잡혀야 한다.
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

describe('scanContent — JSX 구조 검출(리터럴 className 조상)', () => {
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

// story #3839 카디르 QA 보강(2026-09-14 05:30Z) — 최초판은 리터럴 className만 봐서
// `<Alert variant="info">`처럼 tint가 cva variant 정의(컴포넌트 경계) 안에서만 나오는
// 자리를 못 잡았다(activation-checklist-banner.tsx 실사고 재현으로 적발). componentMap을
// 넘기면 그 경계도 리터럴 조상과 동일하게 취급해야 한다.
describe('scanContent — cva variant 컴포넌트 경계(카디르 QA 보강)', () => {
  const infoOnlyMap: ComponentTintMap = new Map([
    ['Alert', new Map([['variant', new Map([['info', 'info' as const]])]])],
  ]);

  it('componentMap에 등재된 <Alert variant="info">는 리터럴 bg-info-tint 조상과 동일하게 잡는다', () => {
    const content = `
      <Alert variant="info">
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    const violations = scanContent(content, 'sample.tsx', infoOnlyMap);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });

  it('componentMap이 없으면(호출부가 안 넘기면) 같은 JSX도 못 잡는다 — 이게 카디르가 적발한 구멍', () => {
    const content = `
      <Alert variant="info">
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  it('componentMap에 없는 variant 값(success)은 안 잡는다(하드코딩 0 — 지도에 있는 것만)', () => {
    const content = `
      <Alert variant="success">
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx', infoOnlyMap)).toEqual([]);
  });

  it('동적 variant 값(리터럴 아님)은 「항상 적용 보장 안 됨」이라 안 잡는다(#2590 A와 동일 정밀성)', () => {
    const content = `
      <Alert variant={someVar}>
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx', infoOnlyMap)).toEqual([]);
  });
});

// story #3839 카디르 QA 보강 — cva() → 컴포넌트 지도 추출 자체의 정확성·완전성 fail-closed.
describe('extractCvaTintVariants — 추출 정확성·완전성', () => {
  it('실 alert.tsx: Alert.variant.{success,warning,destructive,info}가 각자 계열로 잡힌다(하드코딩 대조 아닌 실 파일 대조)', () => {
    const content = readFileSync(path.join(UI_DIR, 'alert.tsx'), 'utf8');
    const { map, incompleteReasons } = extractCvaTintVariants(content, 'components/ui/alert.tsx');
    expect(incompleteReasons).toEqual([]);
    const alertVariants = map.get('Alert')?.get('variant');
    expect(alertVariants?.get('success')).toBe('success');
    expect(alertVariants?.get('warning')).toBe('warning');
    expect(alertVariants?.get('destructive')).toBe('destructive');
    expect(alertVariants?.get('info')).toBe('info');
    // default variant는 bg-muted/40이라 tint 계열이 아니므로 지도에 없어야 한다(지어내지 않음).
    expect(alertVariants?.has('default')).toBe(false);
  });

  it('실 badge.tsx: Badge.variant.{destructive,success,info,warning}이 각자 계열로 잡힌다', () => {
    const content = readFileSync(path.join(UI_DIR, 'badge.tsx'), 'utf8');
    const { map, incompleteReasons } = extractCvaTintVariants(content, 'components/ui/badge.tsx');
    expect(incompleteReasons).toEqual([]);
    const badgeVariants = map.get('Badge')?.get('variant');
    expect(badgeVariants?.get('destructive')).toBe('destructive');
    expect(badgeVariants?.get('success')).toBe('success');
    expect(badgeVariants?.get('info')).toBe('info');
    expect(badgeVariants?.get('warning')).toBe('warning');
  });

  it('cva에 tint 클래스가 있는데 호출하는 컴포넌트를 못 찾으면(orphan) 완전성 fail-closed로 신고한다', () => {
    const content = `
      const orphanVariants = cva('base', {
        variants: { variant: { info: 'bg-info-tint text-foreground' } },
      });
      // orphanVariants를 쓰는 컴포넌트가 파일 안에 없다 — 지도로 못 옮겨짐.
    `;
    const { map, incompleteReasons } = extractCvaTintVariants(content, 'sample.tsx');
    expect(map.size).toBe(0);
    expect(incompleteReasons.length).toBeGreaterThan(0);
    expect(incompleteReasons[0]).toContain('orphanVariants');
  });

  it('cva variants 밖에 원시 tint 클래스가 더 있으면(구조화 추출이 못 옮김) 완전성 fail-closed로 신고한다', () => {
    const content = `
      const fooVariants = cva('base', {
        variants: { variant: { info: 'bg-info-tint text-foreground' } },
      });
      function Foo({ variant }) {
        return <div className={fooVariants({ variant })} data-extra="bg-warning-tint" />;
      }
    `;
    const { incompleteReasons } = extractCvaTintVariants(content, 'sample.tsx');
    expect(incompleteReasons.some((r) => r.includes('추출 완전성 fail-closed'))).toBe(true);
  });
});

describe('buildComponentTintMap — 실 components/ui 디렉터리 전수(완전성 fail-closed 0)', () => {
  it('실 UI_DIR 스캔이 incompleteReasons 0으로 끝난다(현재 develop 기준 — 모호한 cva 0)', () => {
    const { incompleteReasons } = buildComponentTintMap(UI_DIR);
    expect(incompleteReasons).toEqual([]);
  });
});

// story #3839 AC2(카디르 QA 지적, 2026-09-14 05:30Z) — "단위테스트도 실 파일 내용에 문자열
// 치환으로·합성 표본은 보조". activation-checklist-banner.tsx **실 파일**을 읽어, 고쳐진
// 형태가 0건인지·그중 실제로 한 곳을 되돌리면(원래 버그 패턴) RED가 되는지 실측한다 —
// 합성 표본(위 describe들)은 이 실 파일 판정의 보조일 뿐 주 판정이 아니다.
describe('scanContent — 실 파일 뮤테이션(activation-checklist-banner.tsx, AC2 주 판정)', () => {
  const REL_FILE = 'components/dashboard/activation-checklist-banner.tsx';
  const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
  const { map: componentMap, incompleteReasons } = buildComponentTintMap(UI_DIR);
  const original = readFileSync(ABS_FILE, 'utf8');

  it('전제: componentMap 추출이 완전함(incompleteReasons 0) — 이래야 아래 판정을 신뢰할 수 있다', () => {
    expect(incompleteReasons).toEqual([]);
  });

  it('고쳐진 실 파일(develop HEAD, PR #4259 반영분) — 위반 0건', () => {
    expect(scanContent(original, REL_FILE, componentMap)).toEqual([]);
  });

  it('실 파일에서 한 곳(첫 번째 text-foreground 고정 자리)을 원래 버그로 되돌리면 RED', () => {
    const target = "'text-foreground',";
    expect(original.includes(target)).toBe(true);
    // 문자열 .replace는 첫 매치 1건만 바꾼다 — "한 곳"을 결정적으로 고른다.
    const mutated = original.replace(target, "met ? 'text-foreground' : 'text-muted-foreground',");
    expect(mutated).not.toBe(original);
    const violations = scanContent(mutated, REL_FILE, componentMap);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });
});
