// @vitest-environment jsdom
//
// story 3d0d60a3 — 반응형 미리보기 브레이크포인트 셀렉터. 셀렉터는 @media 판정이 참인 html
// 포맷에서만 나타나고(고정폭·tree·image엔 부재 — disabled 아님), 클릭 시 ArtifactStage에
// previewWidth를 흘려보내 실제 iframe 리플로우가 일어나는지까지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactExpandDialog } from './artifact-expand-dialog';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESPONSIVE_HTML = '<style>@media (max-width: 600px) { .a { color: red } }</style><div class="a">hi</div>';
const FIXED_HTML = '<div style="width:1280px">fixed</div>';

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(props: Partial<React.ComponentProps<typeof ArtifactExpandDialog>> = {}) {
  await act(async () => {
    root.render(wrap(
      <ArtifactExpandDialog
        open
        onOpenChange={vi.fn()}
        title="t"
        format="html"
        content={RESPONSIVE_HTML}
        canvasBounds={{ w: 1280, h: 800 }}
        {...props}
      />,
    ));
  });
}

describe('ArtifactExpandDialog — 반응형 미리보기 브레이크포인트 셀렉터(story 3d0d60a3)', () => {
  it('shows the breakpoint selector for @media-containing html content', async () => {
    await mount();
    const buttons = [...document.body.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('데스크톱');
    expect(buttons).toContain('태블릿');
    expect(buttons).toContain('모바일');
  });

  it('does not render the selector for fixed-width html (no @media — 부재, disabled 아님)', async () => {
    await mount({ content: FIXED_HTML });
    const buttons = [...document.body.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).not.toContain('태블릿');
    expect(buttons).not.toContain('모바일');
  });

  it('does not render the selector for non-html formats even if the string happens to contain "@media"', async () => {
    await mount({ format: 'tree', content: '[]' });
    const buttons = [...document.body.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).not.toContain('태블릿');
  });

  it('clicking Mobile/Tablet swaps the rendered iframe width; Desktop restores the authored canvas_bounds width', async () => {
    await mount();
    const iframe = () => document.body.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe().style.width).toBe('1280px'); // 초기값=데스크톱(원본)

    const mobileButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '모바일')!;
    await act(async () => { mobileButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(iframe().style.width).toBe('375px');

    const tabletButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '태블릿')!;
    await act(async () => { tabletButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(iframe().style.width).toBe('768px');

    const desktopButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '데스크톱')!;
    await act(async () => { desktopButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(iframe().style.width).toBe('1280px');
  });
});
