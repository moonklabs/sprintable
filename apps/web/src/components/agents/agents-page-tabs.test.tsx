// story #2952 AC1(발견성) — 사이드바 GNB "조직›워크포스"·settings의 "에이전트 관리로
// 이동" 버튼이 모두 ?tab= 없이 /organization/workforce로 보내는데, 실제 삭제(비활성화)/
// 재활성 액션은 관리 탭에만 있었다(통계 탭은 차트뿐). 첫 방문자가 통계 탭에 떨어져
// "삭제 경로가 없다"고 오판한 게 이 스토리의 실사례(PO+선생님) — 기본 탭을 'manage'로
// 정정한 판정 함수 자체를 고정한다(전체 컴포넌트 마운트는 access-matrix-tab.test.tsx와
// 동형으로 무거워 순수 판정 로직만 export해 직접 검증).
import { describe, expect, it } from 'vitest';
import { resolveTab } from './agents-page-tabs';

describe('resolveTab (story #2952 AC1)', () => {
  it('tab 파라미터가 없으면(첫 방문·?tab= 없는 링크) 기본값은 manage — stats 아님', () => {
    expect(resolveTab(null)).toBe('manage');
  });

  it('유효하지 않은 tab 값도 manage로 낙하한다', () => {
    expect(resolveTab('bogus')).toBe('manage');
  });

  it('명시적으로 지정한 유효 탭은 그대로 존중한다', () => {
    expect(resolveTab('stats')).toBe('stats');
    expect(resolveTab('recruit')).toBe('recruit');
    expect(resolveTab('access')).toBe('access');
    expect(resolveTab('manage')).toBe('manage');
  });
});
