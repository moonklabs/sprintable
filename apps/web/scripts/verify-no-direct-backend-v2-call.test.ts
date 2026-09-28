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

  // ⭐story #4089 실사고 픽스처 — 위 #3300 사고와 같은 클래스인데 이 가드가 못 잡았다.
  // 호출부가 URL 리터럴을 fetchWithAuth() 인자 자리에 직접 안 쓰고, 파일 상단
  // `const XXX_API_PATH = '/api/v2/...'`로 한 번 거친 뒤 템플릿 리터럴 `${XXX_API_PATH}...`
  // 로 보간해서 불렀다(use-material-lineage.ts/use-hook-performances.ts/use-material-
  // performances.ts 원문 그대로) — 정규식이 `fetchWithAuth(` 바로 뒤 리터럴이 `/api/v2/`로
  // *시작*하는지만 보므로, 첫 문자가 `${`인 이 형태는 구조적으로 놓친다.
  it('#4089 실사고 픽스처 — const 변수 경유 템플릿 보간도 잡는다(고치기 前 use-material-lineage.ts 원문)', () => {
    const hits = extractDirectV2Calls(
      [
        "const MATERIAL_LINEAGE_API_PATH = '/api/v2/material-lineage';",
        'const res = await fetchWithAuth(`${MATERIAL_LINEAGE_API_PATH}?${params.toString()}`);',
      ].join('\n'),
      'hooks/use-material-lineage.ts',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.urlPrefix).toBe('/api/v2/material-lineage?');
  });

  it('BFF 경로 const로 고친 뒤에는 안 잡는다(회귀 0)', () => {
    const hits = extractDirectV2Calls(
      [
        "const MATERIAL_LINEAGE_API_PATH = '/api/material-lineage';",
        'const res = await fetchWithAuth(`${MATERIAL_LINEAGE_API_PATH}?${params.toString()}`);',
      ].join('\n'),
      'hooks/use-material-lineage.ts',
    );
    expect(hits).toEqual([]);
  });

  it('v2 const라도 fetchWithAuth 호출에서 안 쓰이면(다른 용도) 안 잡는다(과판정 0)', () => {
    const hits = extractDirectV2Calls(
      [
        "const UNUSED_V2_PATH = '/api/v2/whatever';",
        "const res = await fetchWithAuth('/api/stories');",
      ].join('\n'),
      'f.ts',
    );
    expect(hits).toEqual([]);
  });
});
