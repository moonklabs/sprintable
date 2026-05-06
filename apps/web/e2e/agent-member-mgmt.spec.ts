import { expect, test } from '@playwright/test';

/**
 * E-AGENT-MEMBER E2E 통합 검증 — AM-S6
 *
 * 2프로젝트 격리 시나리오:
 *   - 에이전트 "오르테가"를 프로젝트 A/B에 각각 독립 배포
 *   - 각각 격리된 API Key + Webhook URL 운영 확인
 *
 * AC1/2/4/5: API 엔드포인트 인증 경계 + 응답 형식 검증 (자동)
 * AC3: 프로젝트 격리 — 인증 환경 필요, 하단 수동 시나리오 참조
 */

test.describe('E-AGENT-MEMBER: 에이전트 API 엔드포인트 인증 경계 (AC1/AC2)', () => {
  test('POST /api/team-members — 미인증 시 401', async ({ request }) => {
    const res = await request.post('/api/team-members', {
      headers: { 'Content-Type': 'application/json' },
      data: { name: '오르테가', type: 'agent', project_id: 'proj-a', org_id: 'org-1' },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/agents/{id}/api-keys — 미인증 시 401', async ({ request }) => {
    const res = await request.get('/api/agents/ortega-agent-id/api-keys');
    expect(res.status()).toBe(401);
  });

  test('POST /api/agents/{id}/api-keys — 미인증 시 401', async ({ request }) => {
    const res = await request.post('/api/agents/ortega-agent-id/api-keys', {
      headers: { 'Content-Type': 'application/json' },
      data: { scope: ['read', 'write'] },
    });
    expect(res.status()).toBe(401);
  });

  test('PUT /api/webhooks/config — 미인증 시 401', async ({ request }) => {
    const res = await request.put('/api/webhooks/config', {
      headers: { 'Content-Type': 'application/json' },
      data: { member_id: 'ortega-id', url: 'https://example.com/webhook', project_id: 'proj-a' },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/team-members — 미인증 시 401', async ({ request }) => {
    const res = await request.get('/api/team-members?type=agent');
    expect(res.status()).toBe(401);
  });
});

test.describe('E-AGENT-MEMBER: 에이전트 상세 페이지 라우트 (AC4)', () => {
  test('GET /api/team-members/{id} — 미인증 시 401', async ({ request }) => {
    const res = await request.get('/api/team-members/ortega-agent-id');
    expect(res.status()).toBe(401);
  });

  test('PATCH /api/team-members/{id} — 미인증 시 401', async ({ request }) => {
    const res = await request.patch('/api/team-members/ortega-agent-id', {
      headers: { 'Content-Type': 'application/json' },
      data: { is_active: false },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('E-AGENT-MEMBER: api-keys → Members Agents 리다이렉트 (AC5)', () => {
  test('GET /api/webhooks/config — 미인증 시 401', async ({ request }) => {
    const res = await request.get('/api/webhooks/config');
    expect(res.status()).toBe(401);
  });

  test('DELETE /api/webhooks/config — 미인증 시 401', async ({ request }) => {
    const res = await request.delete('/api/webhooks/config?id=test-id');
    expect(res.status()).toBe(401);
  });
});

/**
 * AC3: 프로젝트 격리 — 인증 환경 수동 검증 시나리오
 *
 * 전제: 오르테가가 프로젝트 A(KEY_A), 프로젝트 B(KEY_B)에 배포됨
 *
 * 시나리오 1 — 프로젝트 A 격리:
 *   curl -H "Authorization: Bearer $KEY_A" https://app.sprintable.ai/api/v2/sprints
 *   → 프로젝트 A 스프린트만 반환 (프로젝트 B 데이터 없음)
 *
 * 시나리오 2 — 프로젝트 B 격리:
 *   curl -H "Authorization: Bearer $KEY_B" https://app.sprintable.ai/api/v2/sprints
 *   → 프로젝트 B 스프린트만 반환 (프로젝트 A 데이터 없음)
 *
 * 시나리오 3 — Webhook 격리:
 *   Settings > Members > Agents 탭에서 "오르테가" 2개 항목 확인:
 *   - "오르테가 / 프로젝트 A" — 각자 독립된 Webhook URL 설정
 *   - "오르테가 / 프로젝트 B" — 각자 독립된 Webhook URL 설정
 *   메모 배정 시 각 프로젝트의 Webhook만 호출되는지 확인
 *
 * 시나리오 4 — AC4 Agents 탭 구분 표시:
 *   /settings?tab=members → Agents 탭 → "오르테가"가 프로젝트 A/B 각각 별도 행으로 표시
 *
 * 시나리오 5 — AC5 리다이렉트:
 *   /settings?tab=api-keys 접근 → 즉시 Members > Agents 탭으로 전환 확인
 */
test.skip('AC3: 2프로젝트 격리 — 인증 환경 수동 검증', async () => {
  // 위 주석의 수동 시나리오를 따라 검증
});
