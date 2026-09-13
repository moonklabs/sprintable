/**
 * story #3826-pre(3826 contrast-guard 실사고 후속) 회귀가드 — `text-{...}foreground/N`처럼
 * Tailwind 알파 투명도 수정자로 텍스트 색을 만드는 패턴을 막는다.
 *
 * 배경: 3826(v3 원시 토큰 교체)에서 `--proof-ink`가 밝아지자, `text-foreground/60`·
 * `text-sidebar-foreground/60`(tabs.tsx·app-sidebar.tsx·business-info-disclosure.tsx 등)가
 * 실 브라우저 합성(alpha compositing)에서 axe color-contrast 미달로 뒤집혔다(예:
 * `#72706d`/`#f1efea` = 4.28:1). 원인은 알파 합성 자체의 구조적 취약성 — 배경(bg)이 바뀌거나
 * ink가 조금만 밝아져도 그 위 알파-블렌드 글자색의 실 명도가 따라 움직여, 미리 계산된 solid
 * 값(`text-muted-foreground` = `--proof-ink-3`, 이미 AA 조정 済)보다 대비가 훨씬 불안정하다.
 * 3826-pre가 실 axe 위반을 낸 tabs.tsx·사이드바 컴포넌트 6곳을 solid 토큰으로 교체했다
 * (verify:v3-token-diff-scope와 달리 이건 컴포넌트 diff라 별 PR).
 *
 * 이 가드는 그 6곳의 회귀만 막는 게 아니라 **같은 패턴 전체**(레포 전수 grep 기준 26개 파일)를
 * 대상으로 하되, 기존 26개는 GRANDFATHER_BASELINE으로 얼리고(각각 다른 화면·별도 triage 필요
 * — 한 PR에서 전부 고치는 대신 문서화) **신규 추가만** 막는다(#2691 raw-fetch 가드와 동일 관례).
 *
 * ⚠️ 이 가드가 «못 잡는» 것: bg 계열 tint·포커스 링 알파류 다른 알파 축은 별개 가드
 * (no-subtle-alpha-bg·no-alpha-focus-ring) 몫 — 이 가드는 텍스트 색의 foreground 알파만 본다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// story #3716 관례 재사용 — 주석 속 문자열(위 문서화용 "text-foreground/60" 언급 등)을
// 실 코드로 오탐하지 않도록 스캔 전에 벗긴다(복제 0).
import { stripComments } from '../../../packages/scripts/i18n-key-parser.js';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

// negative lookbehind(식별자 아님) — verify-no-alpha-focus-ring.ts와 동형 이유(변형 체인
// 뒤에 붙어도 매치되도록 `-`는 문자 클래스에서 제외).
const ALPHA_TEXT_FOREGROUND_RE = /(?<![A-Za-z0-9_])text-[a-z-]*foreground\/[0-9]+/g;

export interface AlphaTextHit {
  file: string;
  token: string;
  key: string;
}

export function extractAlphaTextForeground(content: string, file: string): AlphaTextHit[] {
  const stripped = stripComments(content) as string;
  const hits: AlphaTextHit[] = [];
  for (const m of stripped.matchAll(ALPHA_TEXT_FOREGROUND_RE)) {
    const token = m[0];
    hits.push({ file, token, key: `${file}::${token}` });
  }
  return hits;
}

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

// 3826-pre 착수 시점(2026-09-14) 레포 전수 grep 기준 — 3826이 실제로 깬 6곳(tabs.tsx·
// app-sidebar.tsx·business-info-disclosure.tsx·profile-menu.tsx·legal-footer.tsx·
// sidebar.tsx)은 이미 solid로 교체돼 이 목록에 없다. 나머지 26개 파일은 이 스토리 스코프
// 밖(화면이 전부 다르고 개별 triage 필요) — 신규 재유입만 막고 기존은 얼린다.
export const GRANDFATHER_BASELINE = new Set<string>([
  'app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx::text-foreground/80',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::text-foreground/90',
  'app/(authenticated)/organization/workforce/[id]/page.tsx::text-foreground/80',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::text-foreground/80',
  'app/invite/accept/invite-accept-client.tsx::text-foreground/85',
  'app/invite/accept/invite-accept-client.tsx::text-foreground/70',
  'app/invite/page.tsx::text-foreground/80',
  'app/login/page.tsx::text-foreground/80',
  'app/login/page.tsx::text-foreground/60',
  'app/register/page.tsx::text-foreground/80',
  'components/cage/gate-line-context.tsx::text-foreground/90',
  'components/cage/stuck-handoff-detail.tsx::text-foreground/90',
  'components/cage/stuck-handoff-detail.tsx::text-foreground/80',
  'components/cage/stuck-handoff-detail.tsx::text-foreground/85',
  'components/docs/doc-auto-groups.tsx::text-foreground/80',
  'components/docs/doc-breadcrumb.tsx::text-foreground/70',
  'components/docs/doc-content-renderer.tsx::text-foreground/92',
  'components/docs/doc-search-results.tsx::text-foreground/88',
  'components/docs/doc-toc.tsx::text-foreground/80',
  'components/docs/doc-tree.tsx::text-foreground/88',
  'components/docs/extensions/embed-node.tsx::text-foreground/80',
  'components/docs/policy-doc-browser.tsx::text-foreground/88',
  'components/docs/recents-section.tsx::text-foreground/80',
  'components/loops/context-pack-panel.tsx::text-foreground/80',
  'components/meetings/audio-recorder.tsx::text-foreground/80',
  'components/nav/notification-bell.tsx::text-foreground/70',
  'components/release-notes/whats-new-button.tsx::text-foreground/70',
  'components/standup/standup-board-card.tsx::text-foreground/90',
  'components/standup/standup-feedback-dialog.tsx::text-foreground/90',
  'components/standup/standup-history-section.tsx::text-foreground/80',
  'ee/components/billing/billing-tab.tsx::text-foreground/80',
]);

function main(): number {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  const allHits: AlphaTextHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    allHits.push(...extractAlphaTextForeground(content, rel));
  }

  const seen = new Set<string>();
  const newHits: AlphaTextHit[] = [];
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
    `[3826-pre] text-*foreground/N 알파 스캔 — 파일 ${files.length}개 · 고유 자리 ${seen.size}건 · ` +
      `grandfather(기존 채무, 안 막음) ${baselineHit.size}건`,
  );

  const staleBaseline = [...GRANDFATHER_BASELINE].filter((k) => !baselineHit.has(k));
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ grandfather로 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는): ${staleBaseline.length}건`);
    for (const k of staleBaseline) console.log(`    - ${k}`);
  }

  if (newHits.length > 0) {
    console.error(`\n❌ 신규 text-*foreground/N 알파 ${newHits.length}건 — solid muted 토큰(text-muted-foreground 등)으로 바꿀 것(story #3826-pre 회귀):`);
    for (const h of newHits.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${h.file} → "${h.token}"`);
    }
    console.error(
      '\n알파 합성 텍스트는 배경·기초색이 조금만 바뀌어도 대비가 뒤집힌다 — 이미 AA 조정된' +
        ' solid 토큰(text-muted-foreground 등)을 쓴다. 지금은 못 고치지만 아는 채무면' +
        ' GRANDFATHER_BASELINE에 등재(PO 승인 필요).',
    );
    return 1;
  }

  console.log('\nOK: 새 text-*foreground/N 알파 0건(grandfather는 위 목록대로 남아있음 — 신규만 막는다)');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
