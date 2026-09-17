/**
 * story #4014(유나 시안 7c197474) AC4·AC5/6 — 좁은 폭(390·768)·1440 마케팅 목록 표 3곳
 * (블로그 포스트·채널 포스트·성과 보드)의 자동 실측.
 *
 * ⚠️이 스펙이 «못 잡는» 것(card-surface-guard.spec.ts와 동형 선언 관례):
 *   ①CI e2e owner 계정의 org는 빈 org라 실 행 데이터가 없을 수 있다 — char-split-zero(ⓑ)·
 *     상태 칩 1줄(ⓒ) 단언은 행이 실제로 렌더될 때만 의미가 있어, 행이 0건이면 그 단언은
 *     스킵하고 로그로 명시한다(무행=무의미 통과가 아니라 «검사 못 함»으로 정직하게 남김).
 *     행 데이터가 있는 dev PO Test Org에서의 실측은 유나·PO 몫(스토리 §6).
 *   ②페이지 가로 넘침 0(ⓐ)·표 감싸개 hidden 구조(ⓓ)는 행 유무와 무관하게 항상 검사된다
 *     (페이지 셸·CSS 계약 자체를 재는 것이라 데이터 의존 0).
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

const ROUTES: Array<{ path: string; label: string }> = [
  { path: '/content', label: '블로그 포스트 목록' },
  { path: '/content/channel-posts', label: '채널 포스트 목록' },
  { path: '/organization/insights-board', label: '성과 보드' },
];

const WIDTHS = [390, 768, 1440] as const;

/** ⓑ char-split zero — 텍스트를 품은 요소의 렌더 폭이 40px 미만인 것이 0개. */
async function countNarrowTextNodes(page: Page, containerSelector: string): Promise<number> {
  return page.evaluate((sel) => {
    const container = document.querySelector(sel);
    if (!container) return 0;
    let count = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let node: Element | null = walker.currentNode as Element;
    while (node) {
      const hasDirectText = [...node.childNodes].some(
        (c) => c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim().length > 0,
      );
      if (hasDirectText) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (style.display !== 'none' && rect.width > 0 && rect.width < 40) count++;
      }
      node = walker.nextNode() as Element | null;
    }
    return count;
  }, containerSelector);
}

test.describe('story #4014 — 반응형 마케팅 목록 표', () => {
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      test(`${route.label} @ ${width}px — 가로 넘침 0 · 표/카드 CSS 계약`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const response = await page.goto(route.path);
        expect(response?.status(), `${route.label}@${width}: HTTP status`).toBe(200);
        await page.waitForLoadState('networkidle');

        // ⓐ 페이지 가로 넘침 0(모든 폭·행 유무 무관).
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${route.label}@${width}: 페이지 가로 넘침(px)`).toBeLessThanOrEqual(1);

        // ⓓ 표 감싸개는 CSS(hidden lg:block)로만 좁힌다 — <1024에서 display:none,
        // ≥1024에서 block. 구조 자체가 JS 없이도 SSR/CSS만으로 옳게 좁혀지는지(AC5/6).
        const tableWrapperDisplay = await page.evaluate(() => {
          const table = document.querySelector('table');
          if (!table) return null;
          const wrapper = table.closest('[data-slot="card"]') ?? table.parentElement;
          return wrapper ? getComputedStyle(wrapper).display : null;
        });
        if (tableWrapperDisplay !== null) {
          if (width < 1024) {
            expect(tableWrapperDisplay, `${route.label}@${width}: 표 감싸개 display(<1024는 none)`).toBe('none');
          } else {
            expect(tableWrapperDisplay, `${route.label}@${width}: 표 감싸개 display(≥1024는 none 아님)`).not.toBe('none');
          }
        }

        const cardsWrapperDisplay = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="responsive-data-table-cards"]');
          return el ? getComputedStyle(el).display : null;
        });
        if (cardsWrapperDisplay !== null) {
          if (width < 1024) {
            expect(cardsWrapperDisplay, `${route.label}@${width}: 카드 감싸개 display(<1024는 none 아님)`).not.toBe('none');
          } else {
            expect(cardsWrapperDisplay, `${route.label}@${width}: 카드 감싸개 display(≥1024는 none)`).toBe('none');
          }
        }

        // ⓑ char-split zero — 행이 실제로 있을 때만 의미가 있다(위 한계 ① 참고).
        const activeContainerSelector = width < 1024
          ? '[data-testid="responsive-data-table-cards"]'
          : 'table';
        const hasRows = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.textContent!.trim().length > 0 : false;
        }, activeContainerSelector);
        if (hasRows) {
          const narrowCount = await countNarrowTextNodes(page, activeContainerSelector);
          expect(narrowCount, `${route.label}@${width}: 폭<40px 텍스트 노드(char-split)`).toBe(0);

          // ⓒ 상태 칩 1줄(height == 1줄, whitespace-nowrap 계약 실측).
          const chipHeights = await page.evaluate((sel) => {
            const container = document.querySelector(sel);
            if (!container) return [];
            return [...container.querySelectorAll('[data-status-chip]')].map(
              (el) => (el as HTMLElement).getBoundingClientRect().height,
            );
          }, activeContainerSelector);
          if (chipHeights.length > 0) {
            const maxHeight = Math.max(...chipHeights);
            const minHeight = Math.min(...chipHeights);
            // 칩마다 상태별 내용은 다를 수 있어도(아이콘 유무 등) 세로로 쪼개지면 높이가
            // 2배 이상 뛴다 — 전부 같은 대(±2px) 안에 있으면 1줄로 본다.
            expect(maxHeight - minHeight, `${route.label}@${width}: 상태 칩 높이 편차(2줄 쪼개짐 감지)`).toBeLessThanOrEqual(2);
          }
        } else {
          console.log(`SKIP(무행): ${route.label}@${width} — char-split·칩 1줄 단언은 dev PO Test Org 실측 몫(스토리 §6).`);
        }
      });
    }
  }
});
