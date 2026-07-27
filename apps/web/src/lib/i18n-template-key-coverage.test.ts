// story #2228 — i18n-key-coverage 가드(#2210, i18n-key-coverage.test.ts)는 정적 문자열
// 리터럴 키만 본다. "템플릿 리터럴로 조합해서 만드는" 키(`t(\`status_${s}\`)` 같은 자리)는
// 정적 정규식으로 값을 못 구해 그 가드의 스캔 대상에서 빠진다.
//
// 2026-07-27 실측: apps/web/src 전체에서 그런 자리가 **55곳**(~20개 파일) — 바늘구멍이
// 아니었다. 그 55곳 전부를 소스에서 직접 읽어 "그 변수가 실제로 가질 수 있는 값"을
// TypeScript 유니온 타입·const 배열·순수함수의 반환값에서 전개했다(추측 금지 — 실제 값만).
//
// 결과: 아래 표로 커버되는 finite(유한) 자리 53곳 중 **2개 키가 실제로 누락**돼 있었다
// (agentHitl.escalationMode_timeout_memo · escalationMode_timeout_memo_and_escalate —
// agent-hitl-policy-editor.tsx의 타임아웃 클래스 에스컬레이션 모드 드롭다운, 지금 채움).
// 나머지는 전부 존재 확인됨.
//
// ⛔이 가드도 못 잡는 것 2곳(고의로 남김, "0~2곳이면 바늘구멍" 판정 — #2228 AC6):
//   ① outcome-result-card.tsx의 `metric_${result.metric}` — `MetricDefinition.metric`이
//      `string`(무제한)이고 `source`가 'ga4'|'manual'일 때 실제 GA4/수동 메트릭 이름은
//      4개 내부 메트릭(velocity 등)과 무관한 임의 문자열이다. 이건 "키를 더 채우는" 문제가
//      아니라 호출부 자체가 잘못됐다 — 별도 스토리 후보로 남긴다(이 파일에서 안 고침).
//   ② tool-permission-picker.tsx·recruiter-client.tsx의 `toolPermissions.groups.${key}` —
//      BE `/api/v2/mcp/toolset-catalog`가 SSOT라 그룹 키가 백엔드에서 늘어날 수 있다.
//      현재 알려진 17개(폴백 상수 `toolset-catalog.ts`) 전량은 아래 표로 커버되지만,
//      새 그룹이 백엔드에만 추가되면 컴파일 타임으로 못 잡는 자리로 남는다.
import { describe, expect, it } from 'vitest';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

function hasKey(messages: unknown, dotted: string): boolean {
  const parts = dotted.split('.');
  let cur: unknown = messages;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null || !(p in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string';
}

// [prefix, values[], sourceOfTruth] — sourceOfTruth는 그 값 집합을 어디서 실제로 확인했는지
// (다음 사람이 재검증할 때 다시 읽을 자리).
// ⛔이 표는 손으로 갱신해야 한다(PO 리뷰, 2026-07-27) — 정적 스캔이 아니라 하드코딩이라,
// 새 템플릿 조합 키(`t(\`prefix_${var}\`)` 형태)를 만들면 이 표가 조용히 낡는다. 그 상태로는
// 가드가 계속 초록인데 새 키만 화면에 그대로 뜬다 — 새 조합 키를 추가할 때 반드시 여기 항목을
// 같이 추가할 것.
const TEMPLATE_KEY_TABLE: Array<[string, string[], string]> = [
  ['proofCapsule.risk.', ['low', 'medium', 'high'], 'proof-capsule.tsx RISK_KEY 값 타입'],
  ['settings.mcpConnections.status.', ['active', 'error', 'pending_oauth', 'disconnected'], 'mcp-connection-settings.tsx McpConnectionSummary.status'],
  ['settings.mcpConnections.auth.', ['oauth', 'api_key', 'api_token'], 'mcp-connection-settings.tsx McpConnectionSummary.authStrategy'],
  ['gateConfig.work_', ['done', 'merge'], 'gate-level-matrix.tsx WORK_TYPES'],
  ['gateConfig.actor_', ['agent', 'human'], 'gate-level-matrix.tsx ACTOR_TYPES'],
  ['standup.reviewType_', ['comment', 'approve', 'request_changes'], 'standup-feedback-dialog.tsx StandupReviewType'],
  ['agentRuns.billingMode_', ['managed', 'byom'], 'agent-runs-list.tsx AgentRun.llm_provider'],
  ['agentRuns.status_', ['queued', 'held', 'running', 'hitl_pending', 'completed', 'failed'], 'agent-runs-list.tsx AgentRun.status'],
  ['agentRuns.failureDisposition_', ['retry_scheduled', 'retry_launched', 'retry_exhausted', 'non_retryable'], 'agent-runs-list.tsx AgentRun.failure_disposition'],
  ['agentRuns.toolAuditSource_', ['builtin', 'external'], 'agent-run-detail.tsx:19 toolSource 타입(런타임 추출값은 unconstrained string — 알려진 2값만 커버, ①로 별도 명시)'],
  ['agents.steps.persona.', ['eyebrow', 'title'], 'agent-deployment-wizard.tsx STEP_KEYS'],
  ['agents.steps.model.', ['eyebrow', 'title'], 'agent-deployment-wizard.tsx STEP_KEYS'],
  ['agents.steps.scope.', ['eyebrow', 'title'], 'agent-deployment-wizard.tsx STEP_KEYS'],
  ['agents.steps.review.', ['eyebrow', 'title'], 'agent-deployment-wizard.tsx STEP_KEYS'],
  ['agents.steps.verify.', ['eyebrow', 'title'], 'agent-deployment-wizard.tsx STEP_KEYS'],
  ['agentHitl.catalogSeverity_', ['high', 'critical'], 'agent-hitl-policy.ts HitlHighRiskActionCatalogItem.severity'],
  ['agentHitl.requestType_', ['approval'], 'agent-hitl-policy.ts HITL_REQUEST_TYPES'],
  ['agentHitl.timeoutClass_', ['fast', 'standard', 'extended'], 'agent-hitl-policy.ts HITL_TIMEOUT_CLASS_KEYS'],
  ['agentHitl.escalationMode_', ['timeout_memo', 'timeout_memo_and_escalate'], 'agent-hitl-policy.ts HITL_ESCALATION_MODES (#2228 실측으로 누락 발견·채움)'],
  ['agentHitl.catalog_destructive_change_', ['title', 'body'], 'agent-hitl-policy.ts HITL_HIGH_RISK_ACTION_KEYS'],
  ['agentHitl.catalog_external_side_effect_', ['title', 'body'], 'agent-hitl-policy.ts HITL_HIGH_RISK_ACTION_KEYS'],
  ['agentHitl.catalog_credential_or_billing_change_', ['title', 'body'], 'agent-hitl-policy.ts HITL_HIGH_RISK_ACTION_KEYS'],
  ['agentHitl.approval_manual_hitl_request_', ['title', 'body', 'short'], 'agent-hitl-policy.ts HITL_APPROVAL_RULE_KEYS'],
  ['agentHitl.approval_billing_cap_exceeded_', ['title', 'body', 'short'], 'agent-hitl-policy.ts HITL_APPROVAL_RULE_KEYS'],
  ['agentHitl.timeout_fast_', ['title', 'body'], 'agent-hitl-policy.ts HITL_TIMEOUT_CLASS_KEYS'],
  ['agentHitl.timeout_standard_', ['title', 'body'], 'agent-hitl-policy.ts HITL_TIMEOUT_CLASS_KEYS'],
  ['agentHitl.timeout_extended_', ['title', 'body'], 'agent-hitl-policy.ts HITL_TIMEOUT_CLASS_KEYS'],
  ['agents.toolPermissions.groups.', ['core', 'stories', 'tasks', 'sprints', 'epics', 'chat', 'docs', 'analytics', 'retro', 'standup', 'meetings', 'notifications', 'webhooks', 'rewards', 'audit', 'agent_runs', 'admin'], 'toolset-catalog.ts 폴백 그룹(BE가 SSOT — ②로 별도 명시)'],
  ['agents.healthStateLabel_', ['healthy', 'recovering', 'attention', 'paused', 'deploying'], 'agent-deployment-console.ts DeploymentHealthState'],
  ['agents.healthStateBody_', ['healthy', 'recovering', 'attention', 'paused', 'deploying'], 'agent-deployment-console.ts DeploymentHealthState'],
  ['agents.recoveryCueTitle_', ['hitl', 'deploy_failed', 'resume_deployment', 'retrying', 'manual_retry', 'inspect_failure'], 'agent-deployment-console.ts DeploymentRecoveryCueKey'],
  ['agents.recoveryCueBody_', ['hitl', 'deploy_failed', 'resume_deployment', 'retrying', 'manual_retry', 'inspect_failure'], 'agent-deployment-console.ts DeploymentRecoveryCueKey'],
  ['loops.entityType', ['Loop', 'Hypothesis', 'Decision'], 'context-pack-panel.tsx entity_type 타입'],
  ['loops.aiConfidenceLevel_', ['high', 'medium', 'low'], 'ai-attribution.tsx AiConfidence'],
  ['canvas.responsivePreview', ['Desktop', 'Tablet', 'Mobile'], 'artifact-expand-dialog.tsx PreviewBreakpoint'],
  ['canvas.galleryAxis', ['Epic', 'Story', 'Sprint', 'Doc'], 'artifact-gallery.ts GalleryAxis'],
  ['canvas.galleryFormat', ['Html', 'Tree', 'Image'], 'canvas.ts ArtifactFormat'],
  ['glance.phrase.', ['notStarted', 'justStarted', 'underway', 'almostThere', 'wrappingUp'], 'glance.ts derivePhrase() 반환값'],
  ['glance.recency.', ['justNow', 'aWhileAgo', 'today', 'earlier'], 'glance.ts deriveVagueRecency() 반환값'],
  ['loops.status', ['Draft', 'Briefing', 'Generating', 'Deciding', 'Executing', 'Measuring', 'Closed', 'Abandoned'], 'loop-status-badge.tsx LoopStatus'],
  ['settings.notification_category_', ['story', 'task', 'sprint', 'system'], 'settings/page.tsx NOTIFICATION_CATEGORIES'],
  ['settings.event_', ['story', 'story_assigned', 'task', 'task_assigned', 'task_completed', 'sprint_closed', 'info', 'warning', 'system', 'standup_reminder', 'reward', 'invitation'], 'settings/page.tsx NOTIFICATION_CATEGORIES[].types'],
];

describe('i18n 템플릿 리터럴 조합 키 커버리지 — 정적 가드 사각지대의 유한 부분집합 (#2228)', () => {
  it('전개된 조합 키가 전부 ko.json·en.json 양쪽에 존재한다', () => {
    const missing: string[] = [];
    for (const [prefix, values, source] of TEMPLATE_KEY_TABLE) {
      for (const v of values) {
        const key = `${prefix}${v}`;
        if (!hasKey(ko, key) || !hasKey(en, key)) missing.push(`${key}  (${source})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(`조합 키 ${missing.length}개가 번역 파일에 없다:\n${missing.map((m) => `  ${m}`).join('\n')}`);
    }
    expect(missing).toEqual([]);
  });
});
