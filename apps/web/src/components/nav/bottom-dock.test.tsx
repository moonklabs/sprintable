// @vitest-environment jsdom
// UI-3(a9d56577) — 하단 도크의 토스트가 ds 카드로 그려져도 «옛 ToastContainer가 하던 자리 · 겹침»이 그대로인가.
// 자리(우하단 고정 · 하단 도크 위 여백 · 폰 하단 탭 위 · 맥 앱 창)는 도크 열의 클래스가 쥐고, 열 안 쌓는 뼈대(최신 한 장 shrink-0 · 오래된 것 서브스택)는
// 컨테이너가 쥔다 — 둘 다 옛 판과 같아야 한다. 카드 안쪽(모양)만 ds 카드로 바뀐다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ToastContainer as OldContainer, ToastProvider, useToast } from '@/components/ui/toast';
import { BottomDock } from './bottom-dock';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ setBottomDockBannerSlot: () => {} }) }));
vi.mock('@/lib/support-widget-flag', () => ({ isSupportWidgetEnabled: () => false }));
vi.mock('@/components/support-widget/support-widget-launcher', () => ({ SupportWidgetLauncher: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const wrap = (n: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;

function Adder() {
  const { addToast } = useToast();
  return (
    <>
      <button type="button" data-testid="ok" onClick={() => addToast({ title: '저장했어요', type: 'success' })}>ok</button>
      <button type="button" data-testid="err" onClick={() => addToast({ title: '저장하지 못했어요', type: 'error' })}>err</button>
    </>
  );
}

/** 카드 «안쪽»을 지운 뼈대: 카드 요소(role=status|alert)를 빈 자리표시로 바꾼다 — 열 · 컨테이너 · 래퍼의 클래스와 순서만 남는다. */
function skeleton(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[role="status"], [role="alert"]').forEach((c) => c.replaceWith(document.createComment('card')));
  return clone.outerHTML;
}

describe('하단 도크 — 토스트를 ds 카드로 그려도 자리 · 겹침은 그대로', () => {
  it('⭐도크 열: 우하단 고정 · 하단 도크 위 여백 · 높이 한도 · 아래→위 쌓기(폰 하단 탭 · 맥 앱 창 위 여백은 --bottom-dock-inset)', async () => {
    await act(async () => { root.render(wrap(<ToastProvider><Adder /><BottomDock /></ToastProvider>)); });
    await act(async () => { (container.querySelector('[data-testid="ok"]') as HTMLButtonElement).click(); });
    const column = container.querySelector('[data-slot="ds-toast"]')!.closest('.fixed') as HTMLElement;
    expect(column).not.toBeNull();
    const cls = column.className.split(/\s+/);
    for (const c of ['pointer-events-none', 'fixed', 'right-4', 'z-50', 'bottom-[calc(var(--bottom-dock-inset)+1rem)]', 'flex', 'max-h-[calc(100vh-var(--bottom-dock-inset)-2rem)]', 'min-h-0', 'flex-col-reverse', 'items-end', 'gap-2']) {
      expect(cls, c).toContain(c);
    }
  });

  it('⭐쌓는 뼈대가 옛 컨테이너와 같다 — 같은 토스트들을 옛 컨테이너로 그린 도크와 ds 컨테이너로 그린 도크의 뼈대(카드 안쪽 제외)가 글자까지 같다', async () => {
    const items = [
      { id: 'a', title: '오래된', type: 'success' as const },
      { id: 'b', title: '중간', type: 'info' as const },
      { id: 'c', title: '새것', type: 'error' as const },
    ];
    await act(async () => {
      root.render(wrap(<ToastProvider><div data-testid="old"><OldContainer toasts={items} onDismiss={() => {}} /></div></ToastProvider>));
    });
    const oldSkeleton = skeleton(container.querySelector('[data-testid="old"]')!.firstElementChild!);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    // ds 컨테이너는 도크가 쓰는 그대로(같은 목록)
    const { ToastContainer: DsContainer } = await import('@/components/ds/toast');
    await act(async () => {
      root.render(wrap(<ToastProvider><div data-testid="new"><DsContainer toasts={items} onDismiss={() => {}} /></div></ToastProvider>));
    });
    const newSkeleton = skeleton(container.querySelector('[data-testid="new"]')!.firstElementChild!);
    expect(newSkeleton).toBe(oldSkeleton);
    expect(newSkeleton).toContain('shrink-0'); // 최신 한 장이 따로 shrink-0 래퍼에(항상 온전)
    expect(newSkeleton).toContain('overflow-hidden'); // 오래된 것은 서브스택(넘치면 먼저 잘림)
  });

  it('⭐도크가 그리는 카드는 ds 카드이고(오류 = alert · 그 밖 = status) 열 안에 하나씩 쌓인다', async () => {
    await act(async () => { root.render(wrap(<ToastProvider><Adder /><BottomDock /></ToastProvider>)); });
    await act(async () => { (container.querySelector('[data-testid="ok"]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[data-testid="err"]') as HTMLButtonElement).click(); });
    const cards = Array.from(container.querySelectorAll('[data-slot="ds-toast"]'));
    expect(cards.map((c) => c.getAttribute('role'))).toEqual(['alert', 'status']); // 새것이 DOM 맨 앞(= 열 맨 아래)
    expect(container.querySelector('.animate-slide-in')).toBeNull(); // 옛 카드는 더 안 그려진다
  });
});
