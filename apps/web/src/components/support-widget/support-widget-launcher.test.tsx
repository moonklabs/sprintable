// @vitest-environment jsdom
//
// story #3260(지원v1 v1·2위젯) — 플로팅 런처+오버레이 셸. Support Gateway(#f2a27d2a) 계약이
// 아직 없어 use-support-widget-session.ts는 항상 'unavailable'을 반환한다(no-fiction) — 이
// 테스트는 그 정직한 상태가 실제로 렌더되는지, 그리고 셸 자체의 인터랙션(열기/닫기/Escape)이
// 회귀 없이 동작하는지를 검증한다. 실 네트워크/SSE 계약은 스코프 밖(고아 슬롯 결함 클래스
// 재발 방지 원칙상 이 셸은 애초에 아무 SSE도 구독하지 않는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SidebarProvider } from '@/components/ui/sidebar';
import { SupportWidgetLauncher } from './support-widget-launcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// story #2059(kanban-board.test.tsx)/chat-input.test.tsx와 동일 패턴 — jsdom/Node의 네이티브
// localStorage가 이 실행 환경에서 온전치 않아(--localstorage-file 미설정 시 undefined) Map
// 기반 페이크로 통째로 교체한다.
let localStore: Map<string, string>;
function stubLocalStorage() {
  localStore = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => { localStore.set(k, v); },
    removeItem: (k: string) => { localStore.delete(k); },
    clear: () => { localStore.clear(); },
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubLocalStorage();
  setInnerWidth(1280); // 데스크톱 기본값(각 데스크톱 테스트가 이 값을 가정)
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(sidebarProps: Partial<ComponentProps<typeof SidebarProvider>> = {}) {
  // story #3260 2차 finding — 데스크톱 겹침 회피가 useSidebar()(사이드바 실 폭)를 읽는다.
  // SidebarProvider 밖에서 마운트하면 "useSidebar must be used within a SidebarProvider"로
  // 크래시하므로 실 마운트 자리(dashboard-shell.tsx)와 동형으로 감싼다.
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SidebarProvider {...sidebarProps}>
          <SupportWidgetLauncher />
        </SidebarProvider>
      </NextIntlClientProvider>,
    );
  });
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
}

describe('SupportWidgetLauncher — story #3260 셸', () => {
  it('초기 상태는 런처 버튼만 뜨고 오버레이 패널은 없다', async () => {
    await mount();
    expect(container.querySelector('button')).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('런처 클릭 시 오버레이 패널이 열리고, 다시 클릭하면 닫힌다', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape 키로 열린 패널이 닫힌다', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('본체 대화가 아니라 Sprintable에 직접 연결된다는 문구가 패널에 드러난다(외부 위젯 패키징 요건)', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain(koMessages.supportWidget.panelSubtitle);
  });

  it('Support Gateway 계약 착지 전 — 「준비 중」 정직한 상태만 보이고, 가짜 응답/입력창은 없다(AC5 무신호 금지 원칙의 셸 단계 적용)', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain(koMessages.supportWidget.unavailableTitle);
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });
});

// story #3260 2차 finding(2026-08-31, 유나 pre-merge 수치 판정) — 1차 수정(lg:bottom-40)은
// 「덮는 사이드바 행이 바뀔 뿐」이었다: 런처가 left-5로 사이드바 x-범위 «안»에 있는 한 세로
// 오프셋은 근본 해소가 아니다. useSidebar()의 실 폭(리사이즈 가능 200~360px)을 읽어 사이드바
// 밖으로 가로 이동하는지, collapsed(offcanvas·가시폭 0)·모바일(사이드바가 Sheet라 폭을 안
// 먹음)은 override가 없는지를 고정한다.
describe('SupportWidgetLauncher — story #3260 2차: 사이드바 실 폭 기반 데스크톱 가로 회피', () => {
  it('데스크톱·사이드바 기본폭(256px) 확장 상태 — 런처가 256+16=272px 지점으로 이동한다', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.style.left).toBe('272px');
  });

  it('데스크톱·사이드바 리사이즈된 폭(예: 320px) — 정적 추정이 아니라 실 폭을 그대로 반영한다("폭 가변" 함정 회귀가드)', async () => {
    window.localStorage.setItem('sidebar_width', '320');
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.style.left).toBe('336px');
  });

  it('데스크톱·사이드바 collapsed(offcanvas, 가시폭 0) — 기본 left-5(클래스)로 되돌아가고 인라인 override가 없다', async () => {
    await mount({ defaultOpen: false });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.style.left).toBe('');
    expect(btn.className).toContain('left-5');
  });

  it('모바일(<1024) — 사이드바가 Sheet(오프캔버스)라 화면 폭을 안 먹으므로 사이드바 폭·상태와 무관하게 override가 없다', async () => {
    setInnerWidth(500);
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.style.left).toBe('');
  });

  it('오버레이 패널도 런처와 동일한 가로 오프셋을 공유한다(같은 x축에서 열려야 자연스럽다)', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel.style.left).toBe('272px');
  });
});
