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

// story #3377(결함·customer-zero) — 「크게 보기」는 pan 캔버스로 안 쓰이는 컨텍스트라
// html_blob이면 기본으로 클릭을 받는다(인라인 스테이지는 그대로 pointer-events:none 유지 —
// artifact-stage.test.tsx/artifact-viewer.test.tsx가 그쪽을 덮는다).
describe('ArtifactExpandDialog — 「상호작용」 토글(story #3377)', () => {
  it('defaults to ON for html format — iframe is clickable and scripted, but never allow-same-origin', async () => {
    await mount();
    const iframe = document.body.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.className).not.toContain('pointer-events-none');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent)).toContain('상호작용 켬');
  });

  it('toggling off restores pointer-events:none (pan/zoom 회귀 0 — 캔버스로 되돌아간다)', async () => {
    await mount();
    const toggle = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '상호작용 켬')!;
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const iframe = document.body.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.className).toContain('pointer-events-none');
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent)).toContain('상호작용 끔');
  });

  it('does not render the toggle for non-html formats', async () => {
    await mount({ format: 'tree', content: '[]' });
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('상호작용 켬');
  });

  // 유나 design verdict(41e70eee7) — 토글·Close가 둘 다 ml-auto면 flex auto 마진이 반씩
  // 나뉘어 토글이 헤더 가운데로 뜬다. ml-auto는 언제나 정확히 하나만 갖는다.
  it('exactly one of [toggle, Close] carries ml-auto — never both, never neither (헤더 레이아웃 회귀 가드)', async () => {
    await mount(); // html — 토글 노출
    const toggleBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '상호작용 켬')!;
    const closeBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '닫기')!;
    expect(toggleBtn.className).toContain('ml-auto');
    expect(closeBtn.className).not.toContain('ml-auto');

    await act(async () => {
      root.render(wrap(
        <ArtifactExpandDialog open onOpenChange={vi.fn()} title="t" format="tree" content="[]" canvasBounds={{ w: 1280, h: 800 }} />,
      ));
    });
    const closeBtnNoToggle = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '닫기')!;
    expect(closeBtnNoToggle.className).toContain('ml-auto');
  });

  it('switching to a different artifact resets the toggle to the new format default (같은 원칙 — 브레이크포인트 리셋과 동일 블록)', async () => {
    await mount();
    const offBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '상호작용 켬')!;
    await act(async () => { offBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent)).toContain('상호작용 끔');

    await act(async () => {
      root.render(wrap(
        <ArtifactExpandDialog open onOpenChange={vi.fn()} title="t2" format="html" content={FIXED_HTML} canvasBounds={{ w: 1280, h: 800 }} />,
      ));
    });
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent)).toContain('상호작용 켬');
  });
});

// story #3007(로드맵 P2·PR-E, L1) — 다이얼로그는 floating이라 --elev-overlay.
describe('ArtifactExpandDialog — 로드맵 P2·PR-E L1(다이얼로그 elevation 토큰)', () => {
  it('팝업이 shadow-[var(--elev-overlay)]를 쓰고 shadow-lg는 안 쓴다', async () => {
    await mount();
    const popup = document.body.querySelector('.rounded-xl.bg-card');
    expect(popup?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popup?.className).not.toMatch(/(^|\s)shadow-lg(\s|$)/);
  });
});
