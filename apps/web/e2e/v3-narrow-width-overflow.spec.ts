/**
 * story #4006(critical, 5pt) AC3 — 390·768·1440 세 폭에서 v3 화면 가로 넘침 0을
 * document.documentElement.scrollWidth <= innerWidth로 자동 단언한다(3998 결함③의
 * 근거 재현·재발 방지). 「가설」(story #3989, PR #4383)이 develop에 착지해(2026-09-22)
 * 7화면 전부 단언한다.
 *
 * 이 spec은 TODAY_V3_ENABLED/CHAT_V3_ENABLED/CONNECT_RULES_V3_ENABLED=true 전제라
 * ci.yml의 전용 스텝(v3-narrow-width-e2e job, 이 스텝만 독립 pnpm dev 재기동)에서만
 * 돈다 — contrast-guard/card-surface e2e와 같은 job의 env를 공유하지 않는다(그 스펙들은
 * v3 플래그 OFF 기준을 전제로 해 오염을 막는다).
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ storageState: 'playwright/.auth/owner.json' });

const WIDTHS = [390, 768, 1440] as const;

// bare 경로 — /today·/chat·/connect-rules는 v3 화면 자체가 (authenticated) 밖 독립
// 라우트 그룹(플래그 ON 전제, 이 spec의 존재 이유). /work-list·/hypotheses는 proxy.ts의
// MIGRATED_RESOURCES bare-path 301 안전망이 실 {ws}/{proj}로 보정(레포 기존 관례,
// card-surface-guard.spec.ts와 동형, legacy-resource-tables.ts에 둘 다 등재 확認).
// /organization/insights-board는 이미 org-scope 최상위 라우트라 그대로.
const SCREENS: Array<{ path: string; label: string }> = [
  { path: '/today', label: '오늘' },
  { path: '/chat', label: '대화' },
  { path: '/connect-rules', label: '연결·규칙' },
  { path: '/work-list', label: '일감' },
  { path: '/hypotheses', label: '가설' },
  { path: '/organization/insights-board', label: '결과' },
];

async function scrollWidthOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

for (const { path: screenPath, label } of SCREENS) {
  test.describe(`v3 좁은 폭 가로 넘침 0 — ${label}(${screenPath})`, () => {
    for (const width of WIDTHS) {
      test(`${width}px — scrollWidth <= innerWidth`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(screenPath, { waitUntil: 'domcontentloaded' });
        // v3 화면은 SSE/폴링이 계속 돌아 networkidle이 영영 안 온다(story #4160 선례,
        // 같은 클래스 — chat-v3/today-v3 둘 다 (authenticated) 밖이라 그 문제를 그대로
        // 물려받는다). 화면이 실제로 그려졌다는 신호로 body 자식 노드 존재만 확認.
        await page.locator('body').waitFor({ state: 'visible' });
        await page.waitForTimeout(300);
        const { scrollWidth, innerWidth } = await scrollWidthOverflow(page);
        expect(
          scrollWidth,
          `${label}(${screenPath}) @${width}px — scrollWidth(${scrollWidth}) > innerWidth(${innerWidth}), 가로 넘침(story #4006 AC3 위반)`,
        ).toBeLessThanOrEqual(innerWidth);
      });
    }
  });
}
