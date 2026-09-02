/**
 * story #2691(카디르 3122 QA 전수감사 후속) 회귀가드 — raw `fetch('/api/...')`가 401을
 * 재시도 없이 삼키는 결함 클래스(#2689 근본 원인)의 «재발»을 막는다. #2689가 GNB/inbox
 * 콜드마운트 8곳을, 이 스토리가 카디르 감사 목록 기반 mount-time GET 130곳을 `fetchWithAuth`로
 * 전환했다 — 이 가드는 그 전환이 «미래에도 유지»되도록, `/api/*` 대상 raw fetch가 codebase에
 * 새로 늘어나는 것만 막는다(verify-no-new-md-breakpoint.ts와 동일 관례: 기존 채무는
 * GRANDFATHER_BASELINE으로 얼리고 신규만 막는다).
 *
 * ⚠️이 가드가 «못 잡는» 것(과잉 확장 방지, 선언 없이 초록이면 「전부 봤다」로 읽힌다):
 *   ㉠ POST/PATCH/DELETE 등 사용자 액션 트리거 mutation — #2689/#2691 스코프가 "콜드
 *     마운트 시 자동 발화하는 GET"에 한정됐다(사용자 액션은 401이면 에러 토스트가 뜨는
 *     다른 실패 모드라 이 스토리에서 다루지 않음, PO 승인 스코프). GRANDFATHER_BASELINE에
 *     이미 다수 포함(예: doc-content-renderer.tsx의 disposition=attachment 클릭 경로 —
 *     이건 사실 GET인데도 #2691이 손 댐, 나머지 mutation류는 baseline에 남아있다).
 *   ㉡ 진짜 pre-auth/공개 라우트(share/[token]/page.tsx의 `/api/public/docs/*`·
 *     verify-email/page.tsx의 `/api/auth/verify-email`) — fetchWithAuth 자체가 세션을
 *     전제하므로 이런 자리엔 의미상 안 맞다. EXEMPT_FILES로 원천 제외(baseline에도 안 실림
 *     — "언젠가 고쳐야 할 채무"가 아니라 "고치면 안 되는 자리"이기 때문).
 *   ㉢ 대상 URL이 리터럴로 시작하지 않는 완전 동적 조합(`fetch(endpoint)`처럼 변수 하나만
 *     오는 자리) — 정규식은 문자열/템플릿 리터럴만 본다.
 *   ㉣ `rateLimitedFetch`(다른 관심사 — rate-limit 백오프, 인증 재시도가 아님)로 감싼 호출은
 *     대상에서 제외(이미 별도 계약).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

// ㉡ pre-auth/공개 라우트 — fetchWithAuth로 바꾸면 안 되는 자리(세션 전제 자체가 안 맞음).
export const EXEMPT_FILES = new Set<string>([
  'app/share/[token]/page.tsx', // GET /api/public/docs/{token} — 공개 토큰 라우트, 세션 없는 방문자.
  'app/verify-email/page.tsx', // POST /api/auth/verify-email — 로그인 前 이메일 링크 클릭.
  'app/forgot-password/page.tsx', // POST /api/auth/forgot-password — 로그인 前.
  'app/register/page.tsx', // POST /api/auth/register — 계정 생성 자체, 세션 없음.
  'app/reset-password/page.tsx', // POST /api/auth/reset-password — 로그인 前.
  'app/mfa/page.tsx', // POST /api/auth/2fa/verify — 로그인 2단계(주 세션 아직 미확立).
  'app/unsubscribe/page.tsx', // GET /api/activation/unsubscribe — 이메일 링크 클릭, 세션 없는 방문자(story #3159).
  'app/set-password/confirm/page.tsx', // POST /api/auth/set-password/confirm — 이메일 링크 클릭, verify-email과 동형(pre-auth, story #ab2a503f).
  'lib/db/client.ts', // fetchWithAuth/refreshAuthTokens 자신의 구현 — raw fetch가 원시 primitive.
  'lib/auth/firebase-login-flow.ts', // POST /api/auth/firebase/session — 로그인 자체(세션 교환 전), fetchWithAuth 전제(기존 세션) 자체가 안 맞음.
]);

const RAW_FETCH_RE = /\bfetch\(\s*([`'"])((?:(?!\1).)*)/g;

export interface RawFetchHit {
  file: string;
  urlPrefix: string;
  key: string;
}

/** URL 리터럴의 `${` 이전 고정 접두사만 남긴다(템플릿 보간 변수는 안정적 키가 될 수 없음). */
function stablePrefix(url: string): string {
  const idx = url.indexOf('${');
  return idx === -1 ? url : url.slice(0, idx);
}

export function extractRawFetchApiCalls(content: string, file: string): RawFetchHit[] {
  if (EXEMPT_FILES.has(file)) return [];
  const hits: RawFetchHit[] = [];
  for (const m of content.matchAll(RAW_FETCH_RE)) {
    const url = m[2] ?? '';
    if (!url.startsWith('/api/')) continue;
    // fetchWithAuth(...)/rateLimitedFetch(...) 호출은 `fetch(`로 시작하지 않으므로 이
    // 정규식 자체가 안 걸린다(단어 경계 \b가 앞의 'WithAuth'/'ratelimited' 접두를 배제) —
    // 별도 제외 로직 불요.
    const prefix = stablePrefix(url);
    hits.push({ file, urlPrefix: prefix, key: `${file}::${prefix}` });
  }
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (path.relative(SRC_ROOT, full) === 'app/api') continue; // BE 프록시 라우트 자신 제외.
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

// story #2691 — QA(카디르 PR#3123 reject) 후속 재triage(2026-08-17). 착수 시점 282건 중
// 118건이 실은 콜드마운트 GET(스토리 타깃 결함 클래스, PR#3123 본문 "282건 전수 triage"
// 섹션 참고)이라 fetchWithAuth로 전환했다. 남은 164건은 mutation(POST/PATCH/PUT/DELETE)
// 또는 user-action 핸들러 트리거(클릭/blur/submit 전용, 마운트 경로 없음) — 새로 늘어나는
// 것만 막고 이 목록은 개별 triage(별도 스토리)로 넘긴다. 파일 경로+URL 고정 접두사 조합이
// 키 — 라인 번호 아님(코드 변경에 안 흔들림).
export const GRANDFATHER_BASELINE = new Set<string>([
  'app/(authenticated)/[ws]/[proj]/docs/[slug]/page.tsx::/api/docs/',
  'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx::/api/docs',
  'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx::/api/docs/',
  'app/(authenticated)/[ws]/[proj]/docs/docs-shell-client.tsx::/api/docs',
  'app/(authenticated)/[ws]/[proj]/docs/docs-shell-client.tsx::/api/docs/',
  'app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx::/api/goals/',
  'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx::/api/goals',
  'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx::/api/goals/',
  'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx::/api/goals/bulk',
  'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx::/api/hypotheses',
  'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx::/api/hypotheses/',
  'app/(authenticated)/[ws]/[proj]/goals/steer-dispatch-modal.tsx::/api/goals/steer-dispatch',
  'app/(authenticated)/[ws]/[proj]/retro/page.tsx::/api/retro-sessions',
  'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx::/api/sprints',
  'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx::/api/stories/',
  'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx::/api/stories/backlog?project_id=',
  'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx::/api/stories?project_id=',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::/api/standup',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::/api/standup/feedback',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::/api/standup/feedback/',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::/api/stories?project_id=',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::/api/tasks?story_id=',
  'app/(authenticated)/channel/page.tsx::/api/channel/deliver',
  'app/(authenticated)/channel/page.tsx::/api/channel/upload',
  'app/(authenticated)/inbox/page.tsx::/api/notifications',
  'app/(authenticated)/inbox/page.tsx::/api/team-members/',
  'app/(authenticated)/organization/events/page.tsx::/api/events/definitions/',
  'app/(authenticated)/organization/events/page.tsx::/api/events/publish',
  'app/(authenticated)/organization/roles/page.tsx::/api/org-members/',
  'app/(authenticated)/organization/trust/trust-utils.tsx::/api/trust-scores/history?member_id=',
  'app/(authenticated)/organization/workforce/[id]/page.tsx::/api/webhooks/config',
  'app/(authenticated)/organization/workforce/[id]/page.tsx::/api/webhooks/config?id=',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::/api/agents',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::/api/agents/',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::/api/api-keys/rotate',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::/api/team-members/',
  'app/(authenticated)/rewards/page.tsx::/api/rewards',
  'app/(authenticated)/settings/page.tsx::/api/account/delete',
  'app/(authenticated)/settings/page.tsx::/api/notification-preferences',
  'app/(authenticated)/settings/page.tsx::/api/notification-settings',
  'app/(authenticated)/settings/page.tsx::/api/projects',
  'app/(authenticated)/settings/page.tsx::/api/projects/',
  'app/(authenticated)/settings/page.tsx::/api/webhooks/config',
  'app/(authenticated)/settings/page.tsx::/api/webhooks/config?id=',
  'app/dashboard/dashboard-shell.tsx::/api/switch-org',
  'app/invite/accept/invite-accept-client.tsx::/api/invites/',
  'app/invite/page.tsx::/api/invites/',
  'app/onboarding/onboarding-form.tsx::/api/auth/refresh',
  'app/onboarding/onboarding-form.tsx::/api/auth/resend-verification',
  'app/onboarding/onboarding-form.tsx::/api/current-project',
  'app/onboarding/onboarding-form.tsx::/api/organizations',
  'app/onboarding/onboarding-form.tsx::/api/projects',
  'app/onboarding/onboarding-form.tsx::/api/team-members',
  'app/onboarding/onboarding-telemetry.ts::/api/onboarding/events',
  'components/agents/access-matrix-tab.tsx::/api/projects/',
  'components/agents/agent-management-tab.tsx::/api/team-members/',
  'components/agents/agent-run-detail.tsx::/api/v1/agent-runs/',
  'components/cage/gate-undo-button.tsx::/api/gates/',
  'components/cage/stuck-handoff-section.tsx::/api/stories/',
  'components/canvas/import-artifact-dialog.tsx::/api/visual-artifacts/import-image',
  'components/chat/add-participant-modal.tsx::/api/conversations/',
  'components/chat/attachment-file.tsx::/api/attachments/sign?',
  'components/chat/attachment-media.tsx::/api/attachments/sign?',
  'components/chat/chat-view.tsx::/api/stories/',
  'components/chat/chat-view.tsx::/api/user-blocks',
  'components/chat/delivery-contract-modal.tsx::/api/conversations/',
  'components/chat/delivery-contract-modal.tsx::/api/notification-preferences',
  'components/chat/embed-card.tsx::/api/docs/',
  'components/chat/embed-card.tsx::/api/docs/preview?q=',
  'components/chat/event-block-card.tsx::/api/events/publish',
  'components/chat/new-conversation-modal.tsx::/api/conversations',
  'components/chat/reference-suggestion-row.tsx::/api/docs/preview?q=',
  'components/chat/reference-suggestion-row.tsx::/api/references',
  'components/chat/reference-suggestion-row.tsx::/api/references/',
  'components/chat/reference-suggestion-row.tsx::/api/stories?',
  'components/dispatch/entity-dispatch-panel.tsx::/api/dispatch',
  'components/docs/doc-gate-section.tsx::/api/gates/',
  'components/docs/doc-share-dialog.tsx::/api/docs/',
  'components/docs/extensions/file-node.tsx::/api/attachments/sign?asset_id=',
  'components/docs/extensions/image-upload.ts::/api/docs/',
  'components/docs/extensions/wiki-link.tsx::/api/docs?',
  'components/docs/use-doc-sync.ts::/api/docs/',
  'components/epics/epic-status-transition.tsx::/api/goals/',
  'components/epics/hypothesis-declaration-card.tsx::/api/context-pack/search?project_id=',
  'components/epics/hypothesis-declaration-card.tsx::/api/hypotheses/draft',
  'components/flow/flow-epic-nodes.tsx::/api/stories/',
  'components/flow/flow-epic-nodes.tsx::/api/stories?',
  'components/flow/flow-multi-lane-canvas.tsx::/api/stories/',
  'components/flow/flow-multi-lane-canvas.tsx::/api/stories?',
  'components/flow/flow-relation-review-queue.tsx::/api/stories/',
  'components/flow/goal-stem-card.tsx::/api/goals/',
  'components/flow/goal-stem-card.tsx::/api/stories/',
  'components/flow/guided-hypothesis-entry.tsx::/api/hypotheses/guided',
  'components/flow/next-maker-screen.tsx::/api/stories/',
  'components/flow/orphan-stories-panel.tsx::/api/stories/',
  'components/flow/unattached-bucket.tsx::/api/hypotheses/',
  'components/flow/unattached-bucket.tsx::/api/stories/',
  'components/hypotheses/hypotheses-section.tsx::/api/hypotheses',
  'components/hypotheses/hypotheses-section.tsx::/api/hypotheses/',
  'components/hypotheses/hypotheses-section.tsx::/api/hypotheses/draft',
  'components/hypotheses/hypothesis-gate-badge.tsx::/api/gates/',
  'components/hypotheses/story-hypotheses-section.tsx::/api/hypotheses/',
  'components/inbox/approvals-queue.tsx::/api/gates/',
  'components/inbox/approvals-queue.tsx::/api/v1/hitl-requests/',
  'components/inbox/decisions-waiting.tsx::/api/inbox/',
  'components/integrations/pr-link-section.tsx::/api/integrations/github/links',
  'components/integrations/pr-link-section.tsx::/api/integrations/github/links/',
  'components/kanban/kanban-board.tsx::/api/stories',
  'components/kanban/kanban-board.tsx::/api/stories/',
  'components/kanban/kanban-board.tsx::/api/stories/bulk',
  'components/kanban/kanban-board.tsx::/api/tasks?story_id=',
  'components/kanban/story-card.tsx::/api/workflow/trigger',
  'components/kanban/story-detail-panel.tsx::/api/dependencies',
  'components/kanban/story-detail-panel.tsx::/api/dependencies/',
  'components/kanban/story-detail-panel.tsx::/api/item-labels',
  'components/kanban/story-detail-panel.tsx::/api/item-labels/',
  'components/kanban/story-detail-panel.tsx::/api/labels',
  'components/kanban/story-detail-panel.tsx::/api/stories/',
  'components/loops/artifact-preview.tsx::/api/assets/',
  'components/loops/loop-create-dialog.tsx::/api/hypotheses/draft',
  'components/loops/loop-create-dialog.tsx::/api/loops',
  'components/loops/variant-gallery.tsx::/api/loops/',
  'components/nav/create-organization-dialog.tsx::/api/organizations',
  'components/nav/notification-bell.tsx::/api/event-notifications/',
  'components/nav/notification-bell.tsx::/api/event-notifications/read-all',
  'components/settings/add-member-modal.tsx::/api/organizations/',
  'components/settings/ai-settings.tsx::/api/projects/',
  'components/settings/blocked-users-section.tsx::/api/user-blocks/',
  'components/settings/gate-level-matrix.tsx::/api/organizations/',
  'components/settings/gate-level-matrix.tsx::/api/projects/',
  'components/settings/my-notification-channel-section.tsx::/api/webhooks/config/',
  'components/settings/my-notification-channel-section.tsx::/api/webhooks/config?id=',
  'components/settings/org-members-section.tsx::/api/org-members/',
  'components/settings/set-password-section.tsx::/api/auth/set-password',
  'components/settings/standup-deadline-section.tsx::/api/project-settings',
  'components/settings/two-factor-section.tsx::/api/auth/2fa/disable',
  'components/settings/two-factor-section.tsx::/api/auth/2fa/setup',
  'components/settings/two-factor-section.tsx::/api/auth/2fa/verify',
  'components/settings/workflow-line-editor-section.tsx::/api/workflow-line-config/versions',
  'components/settings/workflow-line-editor-section.tsx::/api/workflow-line-config/versions/',
  'components/settings/workflow-policy-simulator-section.tsx::/api/workflow-line-config/resolve-preview',
  // story #3295 — workflow-template-gallery-section.tsx의 grandfather 항목 제거: 축2-ⓒ
  // (PR#3690)가 이 컴포넌트를 신세대(/api/events/definitions/...)로 이전+fetchWithAuth로
  // 교체하며 이 raw fetch 자체가 없어졌다(재확인 grep: 0건). 죽은 채무를 목록에 남겨두지
  // 않는다.
  'components/settings/workflow-trigger-types-section.tsx::/api/workflow-trigger-types/',
  'components/shared/rejected-relations-section.tsx::/api/stories/',
  'components/sprints/hypothesis-declaration-card.tsx::/api/context-pack/search?project_id=',
  'components/sprints/hypothesis-declaration-card.tsx::/api/hypotheses/draft',
  'components/standup/standup-history-section.tsx::/api/standup/history?project_id=',
  'components/storage/storage-delete-dialog.tsx::/api/assets/',
  'components/storage/storage-view.tsx::/api/folders',
  'components/verify/evidence-section.tsx::/api/evidence',
  'components/verify/evidence-section.tsx::/api/evidence?work_item_id=',
  'ee/components/billing/toss-checkout.ts::/api/billing/checkout',
  'hooks/use-account-switcher.ts::/api/auth/add-account',
  'hooks/use-account-switcher.ts::/api/auth/signout-account',
  'hooks/use-account-switcher.ts::/api/auth/switch-account',
  'hooks/use-unified-switcher.ts::/api/projects',
  'hooks/use-unified-switcher.ts::/api/projects/',
  'hooks/use-unified-switcher.ts::/api/switch-org',
  'hooks/use-unified-switcher.ts::/api/switch-project',
  'services/canvas-spec-pins.ts::/api/visual-artifacts/',
  'services/canvas.ts::/api/visual-artifacts',
  'services/stt-provider.ts::/api/meetings/',
]);

function main(): void {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  const allHits: RawFetchHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    allHits.push(...extractRawFetchApiCalls(content, rel));
  }

  const seen = new Set<string>();
  const newHits: RawFetchHit[] = [];
  const baselineHit = new Set<string>();
  for (const hit of allHits) {
    if (seen.has(hit.key)) continue;
    seen.add(hit.key);
    if (GRANDFATHER_BASELINE.has(hit.key)) {
      baselineHit.add(hit.key);
      continue;
    }
    newHits.push(hit);
  }

  console.log(
    `[AC4] raw fetch('/api/*') 스캔 — 파일 ${files.length}개 · 고유 호출 ${seen.size}건 · ` +
      `grandfather(기존 채무, 안 막음) ${baselineHit.size}건`,
  );

  const staleBaseline = [...GRANDFATHER_BASELINE].filter((k) => !baselineHit.has(k));
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ grandfather로 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는): ${staleBaseline.length}건`);
  }

  if (newHits.length > 0) {
    console.log(`\n❌ 신규 raw fetch('/api/*') ${newHits.length}건 — fetchWithAuth(@/lib/db/client)로 바꿀 것(#2689/#2691 회귀):`);
    for (const h of newHits.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`  - ${h.file} → "${h.urlPrefix}"`);
    }
    console.log(
      '\n→ 정말 인증 세션과 무관한 자리(pre-auth·공개 라우트)면 EXEMPT_FILES에, 지금은 못 고치지만' +
        ' 아는 채무면 GRANDFATHER_BASELINE에 등재(PO 승인).',
    );
    process.exit(1);
  }

  console.log('OK: 새 raw fetch(\'/api/*\') 0건(grandfather는 위 목록대로 남아있음 — 신규만 막는다)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
