/**
 * story #1957(P2-S1, mobile-p2-p1a-story-breakdown SSOT) 회귀가드 — breakpoint SSOT는
 * 390/768/834=모바일, 1024=데스크톱(Tailwind `lg`)으로 수렴했다. `md:`(768) 접두사로 새
 * 레이아웃 분기를 추가하면 `useIsMobile()`(1024 기준)과 어긋나는 "route 내 md·lg 혼재"가
 * 재발한다.
 *
 * 기존 `md:` 사용 파일은 route 단위 원자 전환 원칙(빅뱅 전환 금지 — blueprint §3.6)에 따라
 * ALLOWLIST로 grandfather한다. 이 스크립트는 ALLOWLIST 밖의 파일에서 새로 `md:`가 발견되면
 * 실패한다 — 신규 회귀만 잡고 기존 부채는 개별 스토리(route별 전환)가 처리한다.
 *
 * ALLOWLIST에서 파일을 뺐는데 그 파일이 lg:로 완전 전환됐다면 그대로 통과한다(더는 md: 없음).
 * 아직 md:가 남아있는데 뺐다면 이 스크립트가 실패로 잡아준다 — 안전한 방향의 실수.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(process.cwd(), 'src');

// P2-S1 시점(2026-07-17) 기존 md: 사용 파일 — route별 전환 전까지 grandfather.
// GNB(components/ui/sidebar.tsx·components/nav/top-bar.tsx)는 이번 스토리에서 lg:로
// 전환 완료돼 있어야 하므로 의도적으로 목록에 없다(재도입 시 이 스크립트가 잡는다).
const ALLOWLIST = new Set([
  'app/(authenticated)/[ws]/[proj]/docs/[slug]/page.tsx',
  'app/(authenticated)/[ws]/[proj]/mockups/page.tsx',
  'app/(authenticated)/[ws]/[proj]/retro/[id]/page.tsx',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx',
  'app/(authenticated)/inbox/page.tsx',
  'app/(authenticated)/settings/page.tsx',
  'app/internal-dogfood/page.tsx',
  'components/agents/agent-deployment-verification-step.tsx',
  'components/agents/agent-deployment-wizard.tsx',
  'components/agents/agent-hitl-policy-editor.tsx',
  'components/agents/agent-persona-composer.tsx',
  'components/agents/agent-run-detail.tsx',
  'components/agents/agents-dashboard.tsx',
  'components/dashboard/dashboard-skeleton.tsx',
  'components/dispatch/entity-dispatch-panel.tsx',
  'components/docs/doc-editor.tsx',
  'components/docs/doc-url-chip.tsx',
  'components/epics/epics-skeleton.tsx',
  'components/landing/landing-page.tsx',
  'components/retro/sprint-close-cockpit.tsx',
  'components/settings/org-members-section.tsx',
  'components/settings/slack-integration-settings.tsx',
  'components/settings/workflow-trigger-types-section.tsx',
  'components/standup/standup-feedback-dialog.tsx',
  'components/ui/input.tsx',
  'components/ui/page-header.tsx',
  'components/ui/page-skeleton.tsx',
]);

// Tailwind 반응형 접두사만 매칭 — 콜론 뒤 공백 없이 바로 유틸리티가 붙는 형태(md:hidden 등)만
// 잡는다. 콜론 뒤 공백이 오는 `{ md: 'rounded-md' }` 같은 JS 객체 프로퍼티 오탐을 이 lookahead로
// 배제(오탐 실측: lib/parse-design-tokens.ts의 SM_LG_MAP). arbitrary-variant 등 극단 케이스는
// 스코프 밖.
const MD_PREFIX = /(^|[\s"'`{])md:(?=[a-zA-Z[])/;
const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

const files: string[] = [];
walk(SRC_ROOT, files);

const violations: string[] = [];
for (const abs of files) {
  const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
  if (ALLOWLIST.has(rel)) continue;
  const content = readFileSync(abs, 'utf8');
  if (MD_PREFIX.test(content)) violations.push(rel);
}

if (violations.length > 0) {
  console.error('FAIL: 새 `md:` breakpoint 사용 발견(P2-S1 SSOT=lg:1024 위반):');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nP2-S1(mobile-p2-p1a-story-breakdown) breakpoint SSOT: `lg:`(1024)만 신규 레이아웃 분기에 사용.',
  );
  process.exit(1);
}

console.log(`OK: md: breakpoint 신규 회귀 0건 (grandfather ${ALLOWLIST.size}개 파일 제외 전수 검사)`);
