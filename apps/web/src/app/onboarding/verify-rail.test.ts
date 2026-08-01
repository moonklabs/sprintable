import { describe, expect, it } from 'vitest';
import { parseVerificationRail } from './verify-rail';

// story #2415(2026-08-02, 라이브 재확認 중 발견) — recruiter-client.tsx·connect-step.tsx가
// 각자 `json.data.steps`를 읽었는데, 백엔드(`GET /agents/{id}/verification-status`)의 실제
// 필드명은 `rail`이다. `steps`는 항상 undefined였으므로 검증이 실제로 성공해도 화면 레일은
// 초기 pending에서 한 번도 안 움직였다 — curl로 직접 확認한 실 응답 형태 그대로 고정한다.
describe('parseVerificationRail — story #2415 (steps→rail 필드명 회귀 고정)', () => {
  it('parses the real backend shape ({data:{rail:[...]}}) — this is the exact response captured live via curl', () => {
    const realResponse = {
      data: {
        agent_id: '381276fa-ba35-432a-b5a6-9feadc6c9b03',
        verification_seq: null,
        verified: true,
        rail: [
          { state: 'config_copied', status: 'done' },
          { state: 'waiting', status: 'done' },
          { state: 'mcp_reachable', status: 'done' },
          { state: 'verified', status: 'done' },
        ],
      },
      error: null,
      meta: null,
    };
    expect(parseVerificationRail(realResponse)).toEqual([
      { state: 'config_copied', status: 'done' },
      { state: 'waiting', status: 'done' },
      { state: 'mcp_reachable', status: 'done' },
      { state: 'verified', status: 'done' },
    ]);
  });

  it('regression: a `steps` field (the bug this replaces) is NOT read as rail data', () => {
    // 이전 버그의 정확한 재현 — `steps`라는 필드는 백엔드에 존재한 적이 없다. 이 필드가
    // 있어도(다른 소비처의 실수·구버전 mock 등) 그것을 rail로 오인해서는 안 된다.
    const responseWithWrongFieldName = {
      data: { verified: true, steps: [{ state: 'verified', status: 'done' }] },
    };
    expect(parseVerificationRail(responseWithWrongFieldName)).toBeNull();
  });

  it('returns null (not a crash, not stale data) on malformed/empty responses', () => {
    expect(parseVerificationRail(null)).toBeNull();
    expect(parseVerificationRail(undefined)).toBeNull();
    expect(parseVerificationRail({})).toBeNull();
    expect(parseVerificationRail({ data: {} })).toBeNull();
    expect(parseVerificationRail('not an object')).toBeNull();
  });

  it('also accepts a bare top-level rail (defensive — matches the pre-existing fallback shape)', () => {
    const bareShape = { rail: [{ state: 'config_copied', status: 'done' }] };
    expect(parseVerificationRail(bareShape)).toEqual([{ state: 'config_copied', status: 'done' }]);
  });

  it('also accepts data itself being the array (defensive — matches the pre-existing fallback shape)', () => {
    const dataIsArray = { data: [{ state: 'config_copied', status: 'done' }] };
    expect(parseVerificationRail(dataIsArray)).toEqual([{ state: 'config_copied', status: 'done' }]);
  });
});
