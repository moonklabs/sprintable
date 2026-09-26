// @vitest-environment jsdom
// story #4342 AC1 · AC3 — 390 · 360px에서 목차 드롭다운의 왼쪽 · 오른쪽 끝이 뷰포트 안(유나 390 실측: 왼쪽으로 37px 넘침 · 표식과 첫 글자 잘림).
// jsdom은 배치를 안 해서 패널 사각형을 그 실측 값으로 둔다 → 컴포넌트가 건 translateX를 더한 «실제 경계»를 잰다. 옛 모양(훅 없음)으로 되돌리면 RED.
// 1440은 넘치지 않아 아무것도 안 건다(develop과 같은 모양). 라이트 · 다크는 기하가 같아 한 판(색은 이 칸과 무관 · 유나 실측 몫).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocToc } from './doc-toc';
import { VIEWPORT_GUTTER_PX } from '@/hooks/use-viewport-clamp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let panelLeft = 0;
const PANEL_W = 256; // w-64
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = this.getAttribute('data-dropdown-panel') === 'doc-toc'
      ? { left: panelLeft, width: PANEL_W }
      : { left: 0, width: 0 };
    return { left: r.left, right: r.left + r.width, width: r.width, top: 0, bottom: 0, height: 0, x: r.left, y: 0, toJSON() {} } as DOMRect;
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });

const HEADINGS = [
  { id: 'h1', text: '들어가며', level: 1 },
  { id: 'h2', text: '배경과 문제', level: 2 },
  { id: 'h3', text: '세부 결정', level: 3 },
] as const;

async function openAt(viewport: number, rawLeft: number) {
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewport);
  panelLeft = rawLeft;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocToc headings={HEADINGS.map((h) => ({ ...h }))} onHeadingClick={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { (container.querySelector('button') as HTMLButtonElement).click(); });
  const panel = container.querySelector('[data-dropdown-panel="doc-toc"]') as HTMLElement;
  const shift = Number(/translateX\((-?[\d.]+)px\)/.exec(panel.style.transform)?.[1] ?? 0);
  return { panel, left: rawLeft + shift, right: rawLeft + shift + PANEL_W };
}

describe('DocToc — 좁은 화면 뷰포트 안(story #4342)', () => {
  it.each([
    [390, -37], // 유나 실측
    [360, -67], // 같은 버튼 자리 · 30px 더 좁음
  ] as const)('%ipx: 왼쪽으로 넘친 목록(원래 left %i) → 경계가 [0, 폭] 안 · 여백 8px', async (viewport, rawLeft) => {
    const { left, right } = await openAt(viewport, rawLeft);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(viewport);
    expect(left).toBe(VIEWPORT_GUTTER_PX);
  });

  it('폭 상한 — 뷰포트보다 넓어질 수 없게 max-w-[calc(100vw-1rem)]', async () => {
    const { panel } = await openAt(390, -37);
    expect(panel.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-64', 'max-w-[calc(100vw-1rem)]', 'right-0']));
  });

  it('1440: 넘치지 않으면 아무것도 안 건다(develop과 같은 자리 · 같은 모양)', async () => {
    const { panel, left } = await openAt(1440, 1100);
    expect(panel.style.transform).toBe('');
    expect(left).toBe(1100);
  });
});

// 유나 4714 CHANGES(09:43Z) — 실 셸에선 목차가 **문서 에디터 카드 안**이다: 문서 본문 `overflow-hidden px-4`(docs/[slug]/page.tsx:427) →
// 에디터 카드 `overflow-hidden rounded-xl border`(doc-editor.tsx:326 · 16px 안쪽 · 테두리 1px). 뷰포트 기준 8px 여백이면 카드 가장자리에서
// 왼쪽 테두리 · 모서리가 잘렸다 → 보이는 상자 = 뷰포트 ∩ 카드 안쪽 상자, 그 안에서 8px. 조상 클립을 빼면(뷰포트만) RED.
describe('DocToc — 에디터 카드 안(실 셸 부모 사슬 · 유나 4714 CHANGES)', () => {
  beforeEach(() => {
    (HTMLElement.prototype.getBoundingClientRect as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (this: HTMLElement) {
      const r = this.getAttribute('data-dropdown-panel') === 'doc-toc'
        ? { left: panelLeft, width: PANEL_W }
        : { left: Number(this.dataset.l ?? 0), width: Number(this.dataset.w ?? 0) };
      return { left: r.left, right: r.left + r.width, width: r.width, top: 0, bottom: 0, height: 0, x: r.left, y: 0, toJSON() {} } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'clientLeft', 'get').mockImplementation(function (this: HTMLElement) { return Number(this.dataset.cl ?? 0); });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return Number(this.dataset.cw ?? 0); });
  });

  async function openInCard(viewport: number, rawLeft: number) {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewport);
    panelLeft = rawLeft;
    const cardW = viewport - 32; // px-4 양쪽
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <div style={{ overflow: 'hidden' }} data-l="0" data-w={viewport} data-cl="0" data-cw={viewport}>
            <div style={{ overflow: 'hidden' }} data-l="16" data-w={cardW} data-cl="1" data-cw={cardW - 2}>
              <DocToc headings={HEADINGS.map((h) => ({ ...h }))} onHeadingClick={() => {}} />
            </div>
          </div>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { (container.querySelector('button') as HTMLButtonElement).click(); });
    const panel = container.querySelector('[data-dropdown-panel="doc-toc"]') as HTMLElement;
    const shift = Number(/translateX\((-?[\d.]+)px\)/.exec(panel.style.transform)?.[1] ?? 0);
    return { cardInnerLeft: 17, cardInnerRight: 17 + cardW - 2, left: rawLeft + shift, right: rawLeft + shift + PANEL_W };
  }

  it.each([
    [390, -37],
    [360, -67],
  ] as const)('%ipx: 목록 경계가 [카드 안쪽 + 8, 카드 안쪽 − 8] 안 — 왼쪽 테두리 · 모서리 안 잘림', async (viewport, rawLeft) => {
    const { cardInnerLeft, cardInnerRight, left, right } = await openInCard(viewport, rawLeft);
    expect(left).toBe(cardInnerLeft + VIEWPORT_GUTTER_PX);
    expect(right).toBeLessThanOrEqual(cardInnerRight - VIEWPORT_GUTTER_PX);
  });
});
