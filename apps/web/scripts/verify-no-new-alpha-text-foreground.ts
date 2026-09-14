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
 * 이 가드는 그 6곳의 회귀만 막는 게 아니라 **같은 패턴 전체**(레포 전수 grep 기준 26개 파일·
 * 31개 자리)를 대상으로 하되, 기존 채무는 GRANDFATHER_BASELINE으로 얼리고(각각 다른 화면·별도
 * triage 필요 — 한 PR에서 전부 고치는 대신 문서화) **신규 추가만** 막는다(#2691 raw-fetch
 * 가드와 동일 관례).
 *
 * ⚠️카디르 QA 지적(2026-09-13, PR #4255 뮤테이션 검증) — Set<string> 「존재 여부」 baseline은
 * 두 구멍이 있었다:
 *   ① 고쳐진 자리가 목록에 그대로 남으면, 같은 자리에 같은 토큰이 «재유입»돼도 grandfather로
 *      통과한다(그 시점의 stale-baseline 안내는 경고일 뿐 FAIL이 아니었다 — 조용한 허용).
 *   ② 같은 파일·같은 토큰이 여러 줄에 있으면 Set 키가 하나로 접혀, 그중 «한 곳을 고쳐도»
 *      여전히 개수>0이라 그대로 통과하고, 반대로 «한 곳을 더 늘려도»(개수 증가) 키 존재
 *      여부만 보므로 안 잡힌다(실측: login/page.tsx의 text-foreground/80이 2곳).
 * → 존재 Set이 아니라 **`file::token` → 그 조합의 정확한 발생 개수(Map)**로 바꾼다.
 *   실제 개수가 baseline 개수보다 **많으면**(신규 재유입/증가) FAIL, **적으면**(고쳤는데
 *   목록을 안 뺌 — stale) 이것도 **FAIL**(경고가 아니라 강제 — "고쳤으면 목록에서 빼라").
 *   같으면(정확히 일치) GREEN. 개수 자체가 「그 시점에 실제로 몇 개 있었는지」를 그대로
 *   pin하므로 위 두 구멍이 구조적으로 닫힌다.
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

export function countAlphaTextForeground(content: string, file: string): Map<string, number> {
  const stripped = stripComments(content) as string;
  const counts = new Map<string, number>();
  for (const m of stripped.matchAll(ALPHA_TEXT_FOREGROUND_RE)) {
    const key = `${file}::${m[0]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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

// 3826-pre 착수 시점(2026-09-13, PR #4255 head 기준 재실측) 레포 전수 grep — 3826이
// 실제로 깬 6곳(tabs.tsx·app-sidebar.tsx·business-info-disclosure.tsx·profile-menu.tsx·
// legal-footer.tsx·sidebar.tsx)은 이미 solid로 교체돼 이 목록에 없다. 나머지 26개 파일
// (43개 발생·31개 고유 file::token 조합)은 이 스토리 스코프 밖(화면이 전부 다르고 개별
// triage 필요) — 신규 재유입·증가만 막고 기존 개수는 그대로 얼린다. 값은 **그 file::token
// 조합이 정확히 몇 번 나오는지**(카디르 QA 지적 — Set 존재 여부가 아니라 개수로 pin).
export const GRANDFATHER_BASELINE = new Map<string, number>([
  ['app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx::text-foreground/80', 1],
  ['app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::text-foreground/90', 1],
  ['app/(authenticated)/organization/workforce/[id]/page.tsx::text-foreground/80', 1],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::text-foreground/80', 2],
  ['app/invite/accept/invite-accept-client.tsx::text-foreground/70', 1],
  ['app/invite/accept/invite-accept-client.tsx::text-foreground/85', 3],
  ['app/invite/page.tsx::text-foreground/80', 2],
  ['app/login/page.tsx::text-foreground/60', 2],
  ['app/login/page.tsx::text-foreground/80', 2],
  ['app/register/page.tsx::text-foreground/80', 1],
  ['components/cage/gate-line-context.tsx::text-foreground/90', 1],
  ['components/cage/stuck-handoff-detail.tsx::text-foreground/80', 1],
  ['components/cage/stuck-handoff-detail.tsx::text-foreground/85', 1],
  ['components/cage/stuck-handoff-detail.tsx::text-foreground/90', 1],
  ['components/docs/doc-auto-groups.tsx::text-foreground/80', 1],
  ['components/docs/doc-breadcrumb.tsx::text-foreground/70', 1],
  ['components/docs/doc-content-renderer.tsx::text-foreground/92', 1],
  ['components/docs/doc-search-results.tsx::text-foreground/88', 1],
  ['components/docs/doc-toc.tsx::text-foreground/80', 1],
  ['components/docs/doc-tree.tsx::text-foreground/88', 1],
  ['components/docs/extensions/embed-node.tsx::text-foreground/80', 1],
  ['components/docs/policy-doc-browser.tsx::text-foreground/88', 2],
  ['components/docs/recents-section.tsx::text-foreground/80', 1],
  ['components/loops/context-pack-panel.tsx::text-foreground/80', 1],
  ['components/meetings/audio-recorder.tsx::text-foreground/80', 1],
  ['components/nav/notification-bell.tsx::text-foreground/70', 1],
  ['components/release-notes/whats-new-button.tsx::text-foreground/70', 1],
  ['components/standup/standup-board-card.tsx::text-foreground/90', 3],
  ['components/standup/standup-feedback-dialog.tsx::text-foreground/90', 4],
  ['components/standup/standup-history-section.tsx::text-foreground/80', 1],
  ['ee/components/billing/billing-tab.tsx::text-foreground/80', 1],
]);

export interface BaselineDrift {
  key: string;
  expected: number;
  got: number;
}

export interface BaselineComparison {
  increased: BaselineDrift[];
  stale: BaselineDrift[];
}

/** 순수 함수(카디르 QA 지적, PR #4255 후속) — 실측 개수 맵과 baseline 맵을 비교해
 * 「초과(신규/증가)」·「미달(stale)」을 가른다. main()의 파일시스템 스캔과 분리해
 * 표본 3(초과 FAIL·미달 FAIL·일치 GREEN)을 스캔 없이 직접 단위 테스트할 수 있다. */
export function compareToBaseline(actual: Map<string, number>, baseline: Map<string, number>): BaselineComparison {
  const allKeys = new Set<string>([...actual.keys(), ...baseline.keys()]);
  const increased: BaselineDrift[] = [];
  const stale: BaselineDrift[] = [];
  for (const key of allKeys) {
    const expected = baseline.get(key) ?? 0;
    const got = actual.get(key) ?? 0;
    if (got > expected) increased.push({ key, expected, got });
    else if (got < expected) stale.push({ key, expected, got });
  }
  return { increased, stale };
}

function main(): number {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  const actual = new Map<string, number>();
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    for (const [key, n] of countAlphaTextForeground(content, rel)) {
      actual.set(key, (actual.get(key) ?? 0) + n);
    }
  }

  const { increased, stale } = compareToBaseline(actual, GRANDFATHER_BASELINE);

  const totalActualOccurrences = [...actual.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[3826-pre] text-*foreground/N 알파 스캔 — 파일 ${files.length}개 · 고유 자리 ${actual.size}건 · ` +
      `총 발생 ${totalActualOccurrences}건 · grandfather 등재 ${GRANDFATHER_BASELINE.size}건`,
  );

  if (increased.length === 0 && stale.length === 0) {
    console.log('\nOK: text-*foreground/N 알파 개수가 grandfather와 정확히 일치(신규 0·stale 0).');
    return 0;
  }

  if (increased.length > 0) {
    console.error(`\n❌ 신규/증가한 text-*foreground/N 알파 ${increased.length}건 — solid muted 토큰(text-muted-foreground 등)으로 바꿀 것(story #3826-pre 회귀):`);
    for (const h of increased.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${h.key} (grandfather ${h.expected}건 → 실측 ${h.got}건)`);
    }
  }
  if (stale.length > 0) {
    console.error(`\n❌ stale grandfather ${stale.length}건 — 실제 개수가 등재값보다 적다(고쳤다면 목록에서 개수를 맞출 것):`);
    for (const h of stale.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${h.key} (grandfather ${h.expected}건 → 실측 ${h.got}건)`);
    }
  }
  console.error(
    '\n알파 합성 텍스트는 배경·기초색이 조금만 바뀌어도 대비가 뒤집힌다 — 이미 AA 조정된' +
      ' solid 토큰(text-muted-foreground 등)을 쓴다. GRANDFATHER_BASELINE의 개수는 항상' +
      ' 실측과 정확히 일치해야 한다(늘어도·줄어도 FAIL — PO 승인 없이 조용히 못 움직인다).',
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
