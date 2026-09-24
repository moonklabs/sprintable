/**
 * story #4277(E-MOBILE · 민 기기 탐색 점검 배포 27) — 좁은 폭 가로 넘침 측정 공용 자.
 *
 * `document.documentElement.scrollWidth`만 재면 거짓 PASS가 난다: 대시보드 셸 본문은 `overflow-y-auto` 스크롤러 안에서 그려지고,
 * CSS는 overflow-y만 auto여도 overflow-x를 visible이 아니라 auto로 계산한다 — 그래서 본문이 넘치면 **그 스크롤러 안에서만** 가로로
 * 밀리고 documentElement는 뷰포트 폭 그대로다(402폭 실측: 스크롤러 scrollWidth 896 · documentElement 402 · story #4277 1번).
 *
 * 그래서 이 자는 documentElement와 함께 «세로 스크롤러라서 가로도 암묵적으로 스크롤되는» 요소를 전부 잰다:
 * - 대상: class에 `overflow-y-auto` · `overflow-auto` · `overflow-y-scroll` · `overflow-scroll`이 있고 **`overflow-x-`가 없는** 요소.
 * - 빼는 것: `overflow-x-auto`처럼 가로 스크롤을 **명시한** 요소(칸반 레인 · 넓은 표 — 의도된 가로 스크롤)와 `data-allow-x-scroll`을 단 요소.
 * - 판정: scrollWidth > clientWidth + 1(서브픽셀 반올림 여유 1px).
 */
import type { Page } from '@playwright/test';

export interface HorizontalOverflowOffender {
  tag: string;
  className: string;
  scrollWidth: number;
  clientWidth: number;
}

export async function findHorizontalOverflow(page: Page): Promise<HorizontalOverflowOffender[]> {
  return page.evaluate(() => {
    const out: Array<{ tag: string; className: string; scrollWidth: number; clientWidth: number }> = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) {
      out.push({ tag: 'HTML', className: '(documentElement)', scrollWidth: root.scrollWidth, clientWidth: root.clientWidth });
    }
    const implicitX = /(^|\s)(overflow-y-auto|overflow-auto|overflow-y-scroll|overflow-scroll)(\s|$)/;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!implicitX.test(cls) || cls.includes('overflow-x-') || el.hasAttribute('data-allow-x-scroll')) continue;
      if (el.getClientRects().length === 0) continue; // 안 그려진 요소(display:none 계열)
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push({ tag: el.tagName, className: cls.slice(0, 120), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    }
    return out;
  });
}

/** 옛 자(documentElement만) — 양성 대조용. 새 자와 판정이 갈리는지 보이려고 둔다. */
export async function documentElementOverflows(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}
