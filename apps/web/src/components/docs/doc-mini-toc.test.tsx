// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DocMiniToc, MINI_TOC_MIN_HEADINGS } from './doc-mini-toc';
import type { DocHeading } from './doc-heading-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages = { docs: { tocOnThisDoc: '이 문서' } };

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={messages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function headings(n: number): DocHeading[] {
  return Array.from({ length: n }, (_, i) => ({ id: `h-${i}`, text: `헤딩 ${i}`, level: (i % 3 === 0 ? 1 : 2) as 1 | 2 }));
}

describe('DocMiniToc (story #f546601e — 긴 문서 우측 미니 TOC 자동 표면)', () => {
  it(`헤딩이 ${MINI_TOC_MIN_HEADINGS}개 미만이면 렌더하지 않는다(짧은 문서 무변경 — AC2)`, async () => {
    await act(async () => {
      root.render(wrap(<DocMiniToc headings={headings(MINI_TOC_MIN_HEADINGS - 1)} activeId={null} onHeadingClick={vi.fn()} />));
    });
    expect(container.querySelector('nav')).toBeNull();
  });

  it(`헤딩이 ${MINI_TOC_MIN_HEADINGS}개 이상이면 전체를 렌더한다(AC1)`, async () => {
    const items = headings(19); // 유나 시안 실측 기준 문서
    await act(async () => {
      root.render(wrap(<DocMiniToc headings={items} activeId={null} onHeadingClick={vi.fn()} />));
    });
    const buttons = [...container.querySelectorAll('nav button')];
    expect(buttons).toHaveLength(19);
    expect(buttons[0]?.textContent).toBe('헤딩 0');
  });

  it('activeId와 일치하는 헤딩만 proof-blue로 하이라이트된다(현위치 하이라이트)', async () => {
    const items = headings(6);
    await act(async () => {
      root.render(wrap(<DocMiniToc headings={items} activeId="h-2" onHeadingClick={vi.fn()} />));
    });
    const buttons = [...container.querySelectorAll('nav button')];
    const active = buttons.find((b) => b.getAttribute('aria-current') === 'location');
    expect(active?.textContent).toBe('헤딩 2');
    expect(active?.className).toContain('text-proof-blue');
    expect(buttons.filter((b) => b.getAttribute('aria-current') === 'location')).toHaveLength(1);
  });

  it('헤딩 클릭 시 onHeadingClick이 그 헤딩의 id로 호출된다', async () => {
    const onClick = vi.fn();
    const items = headings(6);
    await act(async () => {
      root.render(wrap(<DocMiniToc headings={items} activeId={null} onHeadingClick={onClick} />));
    });
    const buttons = [...container.querySelectorAll('nav button')];
    await act(async () => { buttons[3]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClick).toHaveBeenCalledWith('h-3');
  });
});
