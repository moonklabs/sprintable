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
