import { describe, expect, it } from 'vitest';
import { extractDirectV2Calls } from './verify-no-direct-backend-v2-call';

describe('extractDirectV2Calls — 순수 판정 함수(story #3300/#3701 재발 가드)', () => {
  it('fetchWithAuth(`/api/v2/...`)를 잡는다', () => {
    const hits = extractDirectV2Calls(
      'fetchWithAuth(`/api/v2/organizations/${orgId}/domain-labels`)',
      'hooks/use-org-domain-labels.ts',
    );
    expect(hits).toEqual([{
      file: 'hooks/use-org-domain-labels.ts',
      urlPrefix: '/api/v2/organizations/',
      key: 'hooks/use-org-domain-labels.ts::/api/v2/organizations/',
    }]);
  });

  // ⭐양성대조 — 이 스토리(#3300)의 실사고를 그대로 재현한 픽스처. 수정 前 코드가 정확히 이
  // 패턴이었다(이 테스트가 RED였다면 회귀가드가 실제로 그 버그를 잡았을 것을 증명).
  it('#3300 실사고 픽스처 — 고치기 前 use-org-domain-labels.ts 원문을 그대로 놓치지 않는다', () => {
    const hits = extractDirectV2Calls(
      "const res = await fetchWithAuth(`/api/v2/organizations/${orgId}/domain-labels`);",
      'hooks/use-org-domain-labels.ts',
    );
    expect(hits).toHaveLength(1);
  });

  it('BFF 경로(/api/organizations/...)로 고친 뒤에는 안 잡는다(회귀 0)', () => {
    const hits = extractDirectV2Calls(
      'fetchWithAuth(`/api/organizations/${orgId}/domain-labels`)',
      'hooks/use-org-domain-labels.ts',
    );
    expect(hits).toEqual([]);
  });

  it('raw fetch(v2)는 이 가드의 대상이 아니다(별도 관심사 — 서버사이드 파일이 정당하게 씀)', () => {
    const hits = extractDirectV2Calls(
      "fetch(`${FASTAPI_URL()}/api/v2/me`)",
      'lib/db/server.ts',
    );
    expect(hits).toEqual([]);
  });

  it('/api/v2/가 아닌 BFF 경로는 안 잡는다', () => {
    const hits = extractDirectV2Calls(`fetchWithAuth('/api/stories')`, 'f.ts');
    expect(hits).toEqual([]);
  });

  it('템플릿 리터럴의 ${} 보간 이전 고정 접두사만 키로 남긴다', () => {
    const hits = extractDirectV2Calls('fetchWithAuth(`/api/v2/team-members/${agentId}`)', 'f.ts');
    expect(hits[0]!.urlPrefix).toBe('/api/v2/team-members/');
  });
});
