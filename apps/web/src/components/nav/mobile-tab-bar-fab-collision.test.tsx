// @vitest-environment jsdom
//
// 카디르 QA HIGH(PR#3354, 2026-08-22) — story #2930 I2가 데스크톱 챗 center와 «세트»로
// 모바일 챗 FAB(left-1/2, 탭바 위 절대위치 원형 버튼)까지 도입했는데, 그 자리가 당시 3탭
// (지금/결재/전체) 균등분할의 결재 탭 중심(정확히 50%)과 기하학적으로 정확히 겹쳤다
// (jsdom엔 실 레이아웃 엔진이 없어 픽셀 대조가 아니라 이 스위트처럼 구조로 증명).
//
// 유나 확定(ⓒ, 2026-08-22): center FAB는 4탭(오늘/워크/신뢰/지식) 최종 상태와 한 세트고,
// 4탭 전환(I4)은 「결재→오늘/AQ」 흡수(=B3 확定) 의존이다 — B3 미확定인 지금은 모바일
// 탭바를 5탭 현행 그대로 두고(챗은 여전히 일반 flex-1 탭), 챗 center는 데스크톱에만
// 산다(app-sidebar.tsx). 이 스위트는 "5탭 현행에 FAB가 없다"를 실 렌더로 고정 — I4가
// B3와 원자적으로 착지하기 전까지, 챗을 다시 슬쩍 FAB로 승격하는 재발을 잡는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/flow',
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { MobileTabBar } = await import('./mobile-tab-bar');
  await act(async () => { root.render(wrap(<MobileTabBar chatUnreadTotal={0} />)); });
  await act(async () => { await Promise.resolve(); });
}

describe('MobileTabBar — 챗 FAB 미도입 회귀가드(story #2930 I2, 유나 확定 ⓒ)', () => {
  it('탭바에 정확히 4개의 flex-1 탭 링크만 있다(FAB 등 절대위치 형제 요소 0건)', async () => {
    await mount();
    const nav = container.querySelector('nav');
    expect(nav).toBeTruthy();
    const links = [...nav!.querySelectorAll('a')];
    expect(links).toHaveLength(4);
    // 전부 flex-1(균등분할 탭)이어야 한다 — absolute 위치 잡힌 FAB라면 이 클래스가 없다.
    for (const link of links) {
      expect(link.className).toContain('flex-1');
      expect(link.className).not.toContain('absolute');
    }
  });

  it('챗은 일반 flex-1 탭 중 하나로 렌더된다(중심 고정 원형 버튼 아님)', async () => {
    await mount();
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats');
    expect(chatLink).toBeTruthy();
    expect(chatLink!.className).toContain('flex-1');
    expect(chatLink!.className).not.toContain('rounded-full');
  });

  it('left-1/2(FAB 중심고정 좌표 클래스) 사용 요소가 탭바 안에 없다', async () => {
    await mount();
    const nav = container.querySelector('nav');
    const fabLike = [...nav!.querySelectorAll('*')].find((el) => el.className.toString().includes('left-1/2'));
    expect(fabLike).toBeUndefined();
  });
});
