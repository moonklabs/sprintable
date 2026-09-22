#!/usr/bin/env node
/**
 * story #3732(2026-09-22, #3731 Docker 빌드 컨텍스트 클래스 재발 방지) — 원래
 * `scripts/check-i18n-keys.js`(저장소 루트, CI 전용) 안에 로컬로 있던 표를 이 파일로
 * 이관했다. 이유: `apps/web/scripts/verify-no-unused-i18n-keys.ts`(프런트 Docker 이미지에
 * 포함되는 빌드 컨텍스트 안)가 저장소 루트 `scripts/`를 직접 import하면
 * `verify-frontend-docker-import-context.ts`(#3731·#3729) 가드가 "Docker 빌드 컨텍스트
 * 밖 참조"로 fail-closed 막는다(Dockerfile builder는 `packages/`만 COPY, 루트 `scripts/`는
 * 안 옮김). `i18n-key-parser.js`가 이미 같은 이유로 이 자리(`packages/scripts/`)에 있다
 * (그 파일 docstring 참조) — 동일 패턴을 그대로 따른다.
 *
 * plain CJS인 이유도 동일 — `check-i18n-keys.js`가 node로 직접 실행되고(로더 없음),
 * apps/web은 allowJs+moduleResolution:bundler라 이 파일을 그대로 require/import할 수 있다.
 */

// AC4 — 동적 조합 화이트리스트. AC3(②)보다 먼저 서야 하는 이유: 이게 없으면 아래 접두사를
// 쓰는 «살아 있는» 키 전부가 dead 후보로 잘못 뜬다(실측 2026-08-01 grep 전수 —
// `grep -rEn "\bt\(\`" apps/web/src` 로 찾은 전체 템플릿 리터럴 t() 호출 기준).
// 각 항목: 그 접두사를 쓰는 실제 호출부 파일 + 왜 정적으로 완전한 키를 못 뽑는지.
const DYNAMIC_KEY_PREFIXES = [
  { prefix: 'kitOrientingWakeBody_', file: 'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx', reason: 't(`kitOrientingWakeBody_${wakeInfo.method}`) — method는 RuntimeWakeMethod 유니온의 런타임 값' },
  { prefix: 'notificationLevel_', file: 'app/(authenticated)/settings/page.tsx', reason: 't(`notificationLevel_${level}`)' },
  { prefix: 'notification_category_', file: 'app/(authenticated)/settings/page.tsx', reason: 't(`notification_category_${category.key}`)' },
  { prefix: 'event_', file: 'app/(authenticated)/settings/page.tsx', reason: 't(`event_${eventType}`)' },
  { prefix: 'status', file: 'app/(authenticated)/[ws]/[proj]/loops/loops-client.tsx', reason: 't(`status${s.charAt(0).toUpperCase()}${s.slice(1)}` as "statusDraft") — camelCase 합성, 접두만 정적(대소문자 변환 이후 값은 런타임)' },
  { prefix: 'work_', file: 'components/settings/gate-level-matrix.tsx', reason: 't(`work_${wt}`)' },
  { prefix: 'actor_', file: 'components/settings/gate-level-matrix.tsx', reason: 't(`actor_${at}`)' },
  { prefix: 'billingMode_', file: 'components/agents/agent-runs-list.tsx', reason: 't(`billingMode_${billingMode}`)' },
  { prefix: 'status_', file: 'components/agents/agent-runs-list.tsx', reason: 't(`status_${s}`) / t(`status_${run.status}`)' },
  { prefix: 'failureDisposition_', file: 'components/agents/agent-runs-list.tsx', reason: 't(`failureDisposition_${getRunFailureDisposition(run)}`)' },
  { prefix: 'toolAuditSource_', file: 'components/agents/agent-run-detail.tsx', reason: 't(`toolAuditSource_${toolSource}`)' },
  { prefix: 'reviewType_', file: 'components/standup/standup-feedback-dialog.tsx', reason: 't(`reviewType_${item.review_type}`) / t(`reviewType_${option}`)' },
  { prefix: 'metric_', file: 'components/outcome/outcome-result-card.tsx', reason: 't(`metric_${result.metric}` as "metric_velocity")' },
  { prefix: 'galleryAxis', file: 'components/canvas/artifact-gallery-view.tsx', reason: 't(`galleryAxis${a[0].toUpperCase()}${a.slice(1)}`) — camelCase 합성' },
  { prefix: 'responsivePreview', file: 'components/canvas/artifact-expand-dialog.tsx', reason: 't(`responsivePreview${bp[0].toUpperCase()}${bp.slice(1)}`) — camelCase 합성' },
  { prefix: 'galleryFormat', file: 'components/canvas/artifact-thumbnail.tsx', reason: 't(`galleryFormat${state.format[0].toUpperCase()}${state.format.slice(1)}`) — camelCase 합성' },
  { prefix: 'entityType', file: 'components/loops/context-pack-panel.tsx', reason: 't(`entityType${item.entity_type...}` as "entityTypeLoop") — camelCase 합성' },
  { prefix: 'aiConfidenceLevel_', file: 'components/loops/ai-attribution.tsx', reason: 't(`aiConfidenceLevel_${confidence}` as "aiConfidenceLevel_high")' },
  { prefix: 'loopPhrase', file: 'components/org-briefing/derive-loop-face.ts', reason: 't(`loopPhrase${capitalize(derivePhrase(...))}`) — camelCase 합성' },
  { prefix: 'laneFlag_', file: 'components/flow/flow-lane.tsx', reason: 't(`laneFlag_${flag.key}`, { n: flag.count })' },
  { prefix: 'portLinkKind_', file: 'components/flow/flow-map-canvas.tsx', reason: 't(`portLinkKind_${kind}`) — 기존 코드베이스 관례' },
  { prefix: 'risk.', file: 'components/proof-capsule/proof-capsule.tsx', reason: 't(`risk.${RISK_KEY[gate.risk]}`) — 상수맵 간접 + 점 표기 하위 네임스페이스' },
  { prefix: 'status.', file: 'components/settings/mcp-connection-settings.tsx', reason: 't(`status.${connection.status}`)' },
  { prefix: 'auth.', file: 'components/settings/mcp-connection-settings.tsx', reason: 't(`auth.${connection.authStrategy}`)' },
  { prefix: 'toolPermissions.groups.', file: 'components/agents/tool-permission-picker.tsx', reason: 't(`toolPermissions.groups.${key}`)' },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDynamicallyComposed(flatKeyPath) {
  return DYNAMIC_KEY_PREFIXES.some(({ prefix }) => {
    const re = new RegExp(`(^|\\.)${escapeRegExp(prefix)}[\\w-]*$`);
    return re.test(flatKeyPath);
  });
}

module.exports = { DYNAMIC_KEY_PREFIXES, isDynamicallyComposed };
