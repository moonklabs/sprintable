/**
 * story #2590 (B) — 런타임 대비 가드(axe-core color-contrast). 주 게이트·최종 authority.
 *
 * (A) 정적 프리필터(verify-cross-element-tint-text.ts)는 «못 재는» 게 본질이다(조건부 조상·
 * 컴포넌트 경계·알파 합성·상태). (B)는 «렌더된 실 픽셀»을 axe-core로 재므로 (A)가 못 보는
 * 교차-요소·교차-계열·상태(hover)·앞으로 생길 것까지 실 맥락에서 전수한다. (A)↔(B) 충돌 시
 * (B) 승(실 픽셀이 authority). (A) 오탐은 `// tint-guard-ok: <이유>`로 표시하되, (B)가 그 줄을
 * 여전히 실측한다.
 *
 * v1 스코프 = «데이터-경량 표면»(settings/onboarding/dashboard/inbox) × 두 테마 × **rest 상태**.
 * 데이터-무거운 flow/kanban은 «CI 시드 vs nightly» 관측 후 조절.
 *
 * ⛔hover 상태는 v1서 뺐다(첫 CI 런 실측 — story #2590 iteration). 40개 인터랙티브를 훑어
 * hover마다 스캔하는 방식은 검출이 «비결정적»이었다(같은 표면이 run 2엔 위반·run 3엔 통과).
 * 게이트는 결정적이어야 하므로(flaky 게이트=무시당해 가드보다 못함) — story #2607(v2)가
 * «등록제 결정적 스캔»으로 재도입했다(아래 HOVER_TARGETS). rest 스캔은 결정적이라 v1의 뼈대다.
 *
 * story #2607(v2) — hover 재도입 근거·설계:
 *   비결정성의 실제 메커니즘을 격리 repro(정적 HTML + `transition-colors` 저대비 버튼)로 재현—
 *   real hover 직후 즉시 스캔은 트랜지션이 «진행 중»일 때 걸릴 수도 안 걸릴 수도 있다(로컬처럼
 *   빠르고 일정한 환경에선 항상 한쪽으로 떨어지지만, CI처럼 렌더/네트워크 지연이 가변적이면
 *   run마다 다른 프레임을 잡는다 — v1이 겪은 정확히 그 증상). 세 후보(트랜지션 disable·
 *   transitionend 대기·고정 대기)를 8회씩 실측 비교해 전부 결정적이었으나, **트랜지션 disable**을
 *   채택한다 — per-element 대기시간 튜닝이 필요 없고(미래에 더 긴 트랜지션이 추가돼도 안 깨짐),
 *   가장 빠르며, 도착점(=:hover의 최종 계산 스타일)은 트랜지션 유무와 무관해 (B)의 «실 픽셀
 *   authority» 원칙과 충돌하지 않는다(트랜지션은 «가는 길»만 바꾸지 도착점을 안 바꾼다).
 *   ⛔단 이건 «정지 상태 hover»만 잰다 — 도착점이 없는 영구 반복 애니메이션(예: hover 중 계속
 *   맥동하는 색)은 이 방식으로 못 잰다(v1의 «못 잡는 것» 목록과 같은 규율로 아래 갱신).
 *
 *   40개 스윕(v1이 뺀 원인) 대신 **등록제** — 페이지별 hover 대상을 role/aria-label 기반 안정
 *   셀렉터로 명시 등록한다(class 기반 셀렉터는 v1이 겪은 클래스-순서 비결정성과 같은 계열의
 *   취약점이라 피한다). 등록 목록에 없는 요소는 미커버 — 이것도 AC4 선언에 반영.
 *
 *   ⚠️seed 데이터 의존 — CI e2e owner는 빈 org만 갖는다(스토리/게이트/에픽 없음, ci.yml
 *   「Onboard e2e owner」 참조). 그래서 데이터가 있어야만 렌더되는 hover 표면(예: 승인대기
 *   카드·활성 에픽 링크)은 등록해도 이 seed로는 안 뜬다 — 항상 렌더되는 앱 셸(사이드바) 요소를
 *   우선 등록하고, 데이터 의존 등록 항목은 요소가 없으면 «스킵»(실패 아님)으로 처리한다(다음
 *   사람이 "왜 이 요소는 한 번도 안 걸리나" 헤매지 않게 스킵 사유를 test.info()에 남긴다).
 *
 * baseline(can only shrink): 지금 «있는» 대비 위반은 실패시키지 않고, «새로 생긴» 위반만
 * 빨간불(자매 정적 가드와 같은 계약). 첫 CI 런이 현 위반을 드러내면 그 키를 baseline에 시드한다.
 * hover 키는 rest 키와 겹치지 않게 `page::theme::hover::색쌍`로 네임스페이스한다.
 *
 * ⚠️ 이 스펙이 «못 잡는 것»(AC4 선언·다음 사람이 «다 본다」로 오독 않게):
 *   ①이 페이지 목록 밖 화면 ②org 데이터가 있어야만 렌더되는 tint 표면(rest·hover 둘 다) ③hover
 *   등록 목록 밖의 인터랙티브 요소(40개 스윕 아님 — 의도된 트레이드) ④정지점이 없는 영구 반복
 *   애니메이션 hover(트랜지션 disable로는 못 잰다) ⑤색맹(axe color-contrast는 명도만) ⑥같은
 *   색쌍의 다른 인스턴스(키가 색쌍이라 접힘 — 새 «색쌍»은 잡지만 기존 색쌍의 새 자리는 안 잡음).
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// axe 결과의 최소 shape만 로컬로 둔다(패키지 타입 export에 의존 안 함·shape는 axe-core 안정 계약).
interface AxeNode { target: string[]; failureSummary?: string; }
interface AxeViolation { id: string; nodes: AxeNode[]; }

test.use({ storageState: './playwright/.auth/owner.json' });

const BASELINE_PATH = path.join(__dirname, 'contrast-axe-baseline.json');
function loadBaseline(): Set<string> {
  try {
    return new Set((JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { keys: string[] }).keys);
  } catch {
    return new Set();
  }
}
const BASELINE = loadBaseline();

// v1 데이터-경량 표면. 각 항목은 그 화면이 렌더하는 tint 표면을 노린다(감사 SSOT 75f15ba7 참조).
const PAGES: Array<{ path: string; label: string }> = [
  { path: '/settings', label: 'settings(danger-zone·gate-matrix·access-tint)' },
  { path: '/onboarding', label: 'onboarding(connect-step info-tint)' },
  { path: '/dashboard', label: 'dashboard(status/tint 위젯)' },
  { path: '/inbox', label: 'inbox(decisions-waiting warning·approvals-queue tint)' },
  // story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §8-3②) —
  // 유나 지시: 등록은 회귀 감시용, 상태 칩의 비텍스트 3:1(dot)은 axe color-contrast가
  // 안 보므로 content-post-manager-states.spec.ts::measureChip이 그 자리 판정을 진다.
  // CI e2e owner는 빈 org라(§ 상단 ⚠️ 참조) 칩 자체가 안 뜰 수 있다 — 그래도 항상
  // 렌더되는 목록 셸(빈 상태·헤더)의 회귀는 이 등록으로 잡힌다.
  { path: '/content', label: 'content(글 관리 — 목록 셸·EmptyState)' },
  // story #3402(Phase1·마케팅운영, AC15·카디르 QA 2026-09-04) — 채널 포스트 목록·편집
  // 화면. 위 /content와 동일 근거(v1은 항상 렌더되는 셸의 회귀 감시용, 상태 칩 비텍스트
  // 3:1은 measureChip 몫) — CI e2e owner가 빈 org라 목록은 EmptyState, 상세는 draft_id
  // 미존재로 오류 알림(editLoadFailed) 셸만 뜨지만 그 표면도 대비 회귀 감시 대상이다.
  { path: '/content/channel-posts', label: 'channel-posts(목록 셸·EmptyState)' },
  { path: '/content/channel-posts/nonexistent-draft-id', label: 'channel-posts detail(오류 알림 셸 — draft 미존재)' },
];
const THEMES = ['light', 'dark'] as const;

/** axe violation → 안정 키 = `page::theme::색쌍(fg/bg)`.
 * ⛔axe의 node.target(CSS 셀렉터)은 클래스 «순서»가 런마다 뒤바뀌어(.pt-4.pb-1 ↔ .pb-1.pt-4)
 * 같은 요소가 다른 키를 내 baseline이 절대 수렴하지 않는다(run 2↔3 실측). 그래서 셀렉터를 키에서
 * 뺐다. 색쌍(fg/bg)은 위반의 «결정적 정체»라 안정적이고 의미도 정확하다(«이 fg가 이 bg 위에서
 * 대비 미달»). 대가(AC4): 같은 색쌍의 «다른 인스턴스»는 하나로 접혀 새로는 안 잡힌다 — 그러나
 * 그건 이미 baseline에 있는 «같은 토큰 채무»이고, 진짜 새로운 것(새 색쌍=새 대비버그)은 그대로
 * 잡힌다. 게이트의 결정성을 위해 granularity를 내준 의도된 trade. */
function extractColorPairs(violations: AxeViolation[]): string[] {
  const pairs = new Set<string>();
  for (const v of violations) {
    for (const node of v.nodes) {
      pairs.add((node.failureSummary ?? '').match(/#[0-9a-f]{3,8}/gi)?.slice(0, 2).join('/') ?? '');
    }
  }
  return [...pairs];
}

function violationKeys(page: string, theme: string, violations: AxeViolation[]): string[] {
  return extractColorPairs(violations).map((colorPair) => `${page}::${theme}::${colorPair}`);
}

// story #2607(v2) — hover 키는 rest 키와 절대 안 겹치게 `hover` 세그먼트를 끼운다(같은 색쌍이
// rest에선 안전하고 hover에서만 위반일 수 있어, 상태를 접으면 그 구분 자체가 사라진다).
function hoverViolationKeys(page: string, theme: string, violations: AxeViolation[]): string[] {
  return extractColorPairs(violations).map((colorPair) => `${page}::${theme}::hover::${colorPair}`);
}

async function setTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // SSE 앱이라 networkidle이 안 서므로 domcontentloaded + 짧은 정착 대기(#dev-pixel 교훈).
  await page.waitForTimeout(1200);
}

async function scanContrast(page: Page): Promise<AxeViolation[]> {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  return results.violations as unknown as AxeViolation[];
}

for (const { path: pagePath, label } of PAGES) {
  for (const theme of THEMES) {
    test(`대비(rest) ${label} [${theme}]`, async ({ page }) => {
      await page.goto(pagePath, { waitUntil: 'domcontentloaded' });
      await setTheme(page, theme);
      const violations = await scanContrast(page);
      const fresh = violationKeys(pagePath, theme, violations).filter((k) => !BASELINE.has(k));
      expect(fresh, `새 대비 위반 ${pagePath}[${theme}] — tint 위 계열색 글자는 text-foreground(#2420). 오탐이면 (A)에 tint-guard-ok, 여기선 baseline 시드.`).toEqual([]);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// story #2607(v2) — hover 상태 축, 등록제 결정적 스캔.
// ─────────────────────────────────────────────────────────────────────────

interface HoverTarget {
  page: string;
  label: string;
  /** role/aria-label 기반 — class 셀렉터는 v1이 겪은 클래스-순서 비결정성과 같은 취약점이라 피함. */
  locate: (page: Page) => ReturnType<Page['getByRole']>;
}

// 앱 셸(사이드바) 요소 — 4페이지 전부에서 항상 렌더된다(seed org에 데이터가 없어도 뜨는 유일한
// 축이라 최우선 등록). 페이지별 고유 표면(승인대기 카드·활성 에픽 링크 등)은 seed가 빈 org라
// 이 CI 환경에서 렌더 안 됨 — 등록해도 스킵될 걸 알면서 넣는 대신, 데이터가 실제로 쌓이는 순간
// 자연히 커버되도록 다음 사람이 채워 넣을 자리로 AC4에 남긴다(추측으로 채우지 않음).
function sidebarHelpTarget(page: string): HoverTarget {
  return {
    page,
    label: 'sidebar help link (앱 셸 · 항상 렌더)',
    // app-sidebar.tsx: <Link aria-label={t('help')} ...> — <a>라 role은 button이 아니라 link.
    locate: (p) => p.getByRole('link', { name: /도움말|help/i }),
  };
}

const HOVER_TARGETS: HoverTarget[] = PAGES.map(({ path: pagePath }) => sidebarHelpTarget(pagePath));

/** 트랜지션을 죽여 hover 최종 계산 스타일을 즉시 적용시킨다(story #2607 결정 — 헤더 docblock
 * 참조). 실 hover(page.locator(...).hover())는 그대로 쓴다 — 강제 클래스로 흉내내지 않는 이유는
 * 실제 :hover 규칙이 바뀌어도 흉내 클래스가 안 따라가면 가드가 거짓 안전을 낼 위험이 있어서다. */
async function disableTransitions(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
}

for (const target of HOVER_TARGETS) {
  for (const theme of THEMES) {
    test(`대비(hover) ${target.label} [${target.page}::${theme}]`, async ({ page }) => {
      await page.goto(target.page, { waitUntil: 'domcontentloaded' });
      await setTheme(page, theme);

      const locator = target.locate(page);
      const count = await locator.count();
      if (count === 0) {
        // seed 데이터 부재 등으로 이 페이지에 없는 요소 — 실패 아님(위 docblock 참조).
        test.info().annotations.push({ type: 'skip-reason', description: `${target.label} not found on ${target.page} — likely data-dependent or not rendered in this env` });
        test.skip();
        return;
      }

      await disableTransitions(page);
      await locator.first().hover();

      const violations = await scanContrast(page);
      const fresh = hoverViolationKeys(target.page, theme, violations).filter((k) => !BASELINE.has(k));
      expect(fresh, `새 hover 대비 위반 ${target.page}[${theme}] hover:${target.label} — tint 위 계열색 글자는 text-foreground(#2420). 오탐이면 (A)에 tint-guard-ok, 여기선 baseline 시드.`).toEqual([]);
    });
  }
}
