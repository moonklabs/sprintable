// story #2365(2026-07-31) 회귀 가드 — 「승인 대기 30」(next-maker-header.tsx의 게이트 카드)과
// 「손 필요한 것 없음」(exception-stream.tsx의 glance 서랍 빈상태)이 같은 /flow 화면에서
// 만나 주어 없이 서로를 반박하던 결함(#2352 「막힘 28 ↔ 막힘 0」의 재발, 세 번째 낱말에서
// 또 만남). 이번엔 낱말만 바꾸지 않고 «무엇을 세는지»를 각 문구에 직접 박았다 — 이 값들이
// 다시 주어 없는 수로 돌아가면(둘 다 「승인 대기」/「없음」류로만 되돌아가면) 여기서 잡는다.
import { describe, expect, it } from 'vitest';
import ko from '../../../messages/ko.json';
import en from '../../../messages/en.json';

describe('story #2365 — 게이트 승인 대기 배지 vs glance 서랍 빈상태, 둘 다 «무엇을 세는지»가 문구에 있다', () => {
  it('ko: nextMakerPendingApproval은 «게이트»를 명시한다(단순 「승인 대기」로 되돌아가면 안 된다)', () => {
    expect(ko.flow.nextMakerPendingApproval).toContain('게이트');
    expect(ko.flow.nextMakerPendingApproval).not.toBe('승인 대기');
  });

  it('ko: exceptionsEmpty는 «승인 흐름»을 명시한다(주어 없는 「손 필요한 것 없음」으로 되돌아가면 안 된다)', () => {
    expect(ko.glance.exceptionsEmpty).toContain('승인 흐름');
    expect(ko.glance.exceptionsEmpty).not.toBe('손 필요한 것 없음');
  });

  it('en: 두 키 다 ko와 같은 주어(gate / step-approval flow)를 명시한다', () => {
    expect(en.flow.nextMakerPendingApproval.toLowerCase()).toContain('gate');
    expect(en.glance.exceptionsEmpty.toLowerCase()).toContain('approval');
  });

  // AC1의 판별 그대로 — 고침 뒤에도 두 수가 «주어 없이» 나란히 설 수 있으면 안 고친 것이다.
  // 두 문구가 «같은 낱말 하나»로 겹치면(예: 둘 다 그냥 "승인"만 있고 무엇의 승인인지 안 갈리면)
  // 다시 자기모순으로 읽힐 수 있다 — 서로 다른 표(게이트 vs 단계 결재)를 가리키는지 확認한다.
  it('두 문구가 가리키는 표가 실제로 다르다(게이트 ≠ 승인 흐름/단계 결재) — 같은 표를 두 이름으로 부르는 게 아니다', () => {
    expect(ko.flow.nextMakerPendingApproval).not.toContain('단계 결재');
    expect(ko.glance.exceptionsEmpty).not.toContain('게이트');
  });
});
