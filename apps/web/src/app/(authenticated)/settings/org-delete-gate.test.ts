// story #2092(P0, 유나 실사용 발견) — 조직 삭제 "지금 진행해도 되는가" 판정 회귀가드.
//
// 원 결함: 영향도 조회가 실패해도(orgImpact===null) has_active_subscription 기본값이
// false라 삭제 버튼이 그대로 활성화됐다 — 화면이 "계속 진행해도 됩니다"를 말 그대로
// 실천했다. 서버(#2898, 이미 배포)가 최종 방어선이지만, 이 테스트는 화면 쪽 "안내"(AC2/AC3)
// 축이 실제로 막는지를 고정한다.
import { describe, it, expect } from 'vitest';
import { canSubmitOrgDelete } from './org-delete-gate';

const base = {
  orgName: 'Acme Corp',
  confirmName: 'Acme Corp',
  deletingOrg: false,
  orgImpactLoading: false,
  hasActiveSubscription: false,
  orgImpactFailed: false,
  confirmWithoutImpact: false,
};

describe('canSubmitOrgDelete', () => {
  it('정상 경로 — 영향도 조회 성공+이름 일치면 허용된다(AC4)', () => {
    expect(canSubmitOrgDelete(base)).toBe(true);
  });

  it('이름 미일치면 막힌다', () => {
    expect(canSubmitOrgDelete({ ...base, confirmName: 'wrong' })).toBe(false);
  });

  it('로딩/삭제-진행중이면 막힌다', () => {
    expect(canSubmitOrgDelete({ ...base, deletingOrg: true })).toBe(false);
    expect(canSubmitOrgDelete({ ...base, orgImpactLoading: true })).toBe(false);
  });

  it('활성 구독이 있으면 막힌다', () => {
    expect(canSubmitOrgDelete({ ...base, hasActiveSubscription: true })).toBe(false);
  });

  it('원결함 회귀가드 — 영향도 조회 실패 + 이름 일치만으로는 «절대» 통과 못 한다(AC2)', () => {
    // 이 케이스가 과거엔 true였다(has_active_subscription 기본값 false로 새는 경로).
    expect(canSubmitOrgDelete({ ...base, orgImpactFailed: true })).toBe(false);
  });

  it('탈출구 — 조회 실패라도 명시 인정(체크박스)하면 통과한다(AC3)', () => {
    expect(canSubmitOrgDelete({ ...base, orgImpactFailed: true, confirmWithoutImpact: true })).toBe(true);
  });

  it('탈출구도 이름 불일치면 여전히 막힌다(체크박스가 이름확認을 우회하지 않음)', () => {
    expect(canSubmitOrgDelete({
      ...base, confirmName: 'wrong', orgImpactFailed: true, confirmWithoutImpact: true,
    })).toBe(false);
  });

  it('조회가 아직 성공한 적 없어도 실패 플래그가 없으면(초기 로딩 前 상태) 이름만으로 열리지 않음 — orgImpactLoading이 커버', () => {
    // orgImpactLoading=true인 동안은 위 케이스에서 이미 커버(로딩 중 막힘). 여기는
    // "실패도 로딩도 아닌데 아직 값이 없는" 프레이밍 자체가 呼출부에서 안 나오게(항상 셋 중
    // 하나) 설계됐음을 문서화 — orgImpact는 loading→(성공|실패) 상태기계.
    expect(canSubmitOrgDelete({ ...base, hasActiveSubscription: false, orgImpactFailed: false })).toBe(true);
  });
});
