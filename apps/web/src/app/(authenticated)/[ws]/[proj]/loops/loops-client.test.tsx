// @vitest-environment jsdom
//
// doc resource-view-firsttouch-identity-pattern §2/§4(실험실 파일럿)·story 1eb18bd8: 빈
// first-touch가 "없습니다" 대신 정체성 explainer(headline+설명+visual+CTA+AI hint)로 렌더되는지,
// 그리고 페이지 타이틀이 nav 라벨("실험실")과 일치하는지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { pushMock, loopCreateDialogOpenSpy } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  loopCreateDialogOpenSpy: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock('@/components/loops/loop-create-dialog', () => ({
  LoopCreateDialog: (props: { open: boolean }) => {
    loopCreateDialogOpenSpy(props.open);
    return null;
  },
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  loopCreateDialogOpenSpy.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { LoopsClient } = await import('./loops-client');
  await act(async () => {
    root.render(wrap(<LoopsClient projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('LoopsClient — 실험실 first-touch 정체성', () => {
  it('페이지 타이틀이 nav 라벨과 일치하는 "실험실"이다(구 "Loop 보드" 아님)', async () => {
    await mount();
    expect(container.textContent).toContain('실험실');
    expect(container.textContent).not.toContain('Loop 보드');
  });

  it('빈 상태가 정체성 explainer(headline+설명+visual+CTA+AI hint) 5요소로 렌더된다', async () => {
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 시작한 실험이 없어요');
    expect(html).toContain('가설을 세우고 실행');
    expect(container.querySelector('svg')).not.toBeNull(); // 4노드 사이클 glyph
    expect(html).toContain('첫 Loop 시작하기');
    expect(html).toContain('AI가 초안을 도와줘요');
    expect(html).not.toContain('Loop이 없습니다'); // 구 카피 소거
  });

  it('빈 상태 CTA 클릭 시 LoopCreateDialog가 open=true로 전환된다(동일 다이얼로그 재사용)', async () => {
    await mount();
    // 초기 렌더 시 open=false 확인.
    expect(loopCreateDialogOpenSpy).toHaveBeenCalledWith(false);
    loopCreateDialogOpenSpy.mockClear();

    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 Loop 시작하기'));
    expect(ctaButton).not.toBeUndefined();
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(loopCreateDialogOpenSpy).toHaveBeenCalledWith(true);
  });
});
