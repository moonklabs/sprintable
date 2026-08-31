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

// story #3260 2차 finding(유나 라이브 실측 FAIL — 재시도 스톰, 2026-08-31) 회귀가드용 —
// isSupportGatewayConfiguredMock 기본값은 false(기존 테스트 전부가 'unavailable'을 가정
// — 이 목이 파일 전체에 적용돼도 회귀 0). 스톰 테스트 describe만 true로 뒤집는다.
const isSupportGatewayConfiguredMock = vi.fn(() => false);
const createOrResumeGatewaySessionMock = vi.fn();
vi.mock('@/lib/support-widget/gateway-client', () => ({
  isSupportGatewayConfigured: () => isSupportGatewayConfiguredMock(),
  createOrResumeGatewaySession: (...args: unknown[]) => createOrResumeGatewaySessionMock(...args),
  listGatewayMessages: vi.fn(),
  sendGatewayMessage: vi.fn(),
}));

// story #3260 3차 finding(선생님 실기기 적발→유나 design 확定, 2026-08-31) — 모바일 채팅-상세
// (/chats/{id})에서만 런처를 숨긴다. 기본값은 chats/layout.test.tsx의 isListRoute 판정과
// 무관한 일반 라우트로 둬서(기존 테스트 전부가 "런처는 언제나 뜬다"를 가정) 회귀 0.
const usePathnameMock = vi.fn(() => '/board');
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}));

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
  isSupportGatewayConfiguredMock.mockReset().mockReturnValue(false);
  createOrResumeGatewaySessionMock.mockReset();
  usePathnameMock.mockReset().mockReturnValue('/board');
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

// story #3260 2차 finding(2026-08-31, 유나 라이브 실측 FAIL) — CSP가 Gateway fetch를
// 막는 상황(즉시·동기에 가깝게 실패)에서 connect()가 4초에 87회(~22/s) 발화했다. 원인은
// launcher의 mount effect가 [open, session] deps라 session(훅 반환 객체, status 변경마다
// 새 참조)이 바뀔 때마다 재발화했던 것 — deps를 [open]으로 좁혀 open 전이 1회만 부르게
// 고쳤다(+훅 쪽 1초 백오프는 2차 방어). 여기서는 실패가 반복돼도 시도 자체가 1회로
// 그치는지를 호출 횟수로 직접 고정한다(회귀 시 이 숫자가 바로 커진다 — 재발이 red가 되는
// 구조).
describe('SupportWidgetLauncher — story #3260 2차: 재시도 스톰 회귀가드', () => {
  it('connect()가 계속 실패해도(예: CSP 차단) 열려있는 동안 세션 발급 시도는 1회로 그친다', async () => {
    isSupportGatewayConfiguredMock.mockReturnValue(true);
    createOrResumeGatewaySessionMock.mockRejectedValue(new Error('Refused to connect: violates CSP directive'));
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 실패 후 status가 'error'로 바뀌며 훅 반환 객체가 새 참조가 되는 렌더가 몇 차례
    // 더 도는데, 그 렌더들 자체가 재시도를 유발하지 않아야 한다.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.supportWidget.errorTitle);
    expect(createOrResumeGatewaySessionMock).toHaveBeenCalledTimes(1);
  });

  it('닫았다 곧바로 다시 열어도(1초 백오프 안) — 훅의 2차 방어가 여전히 막아 1회 그대로다', async () => {
    isSupportGatewayConfiguredMock.mockReturnValue(true);
    createOrResumeGatewaySessionMock.mockRejectedValue(new Error('network down'));
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // open
    await act(async () => { await Promise.resolve(); });
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // close
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // reopen(즉시)
    await act(async () => { await Promise.resolve(); });
    expect(createOrResumeGatewaySessionMock).toHaveBeenCalledTimes(1);
  });

  it('백오프 창(1초)이 지난 뒤 다시 열면(정당한 사용자 재시도) — 2번째 호출이 나온다', async () => {
    vi.useFakeTimers();
    try {
      isSupportGatewayConfiguredMock.mockReturnValue(true);
      createOrResumeGatewaySessionMock.mockRejectedValue(new Error('network down'));
      await mount();
      const btn = container.querySelector('button') as HTMLButtonElement;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // open
      await act(async () => { await Promise.resolve(); });
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // close
      await act(async () => { vi.advanceTimersByTime(1100); }); // 백오프 창 경과
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // reopen
      await act(async () => { await Promise.resolve(); });
      expect(createOrResumeGatewaySessionMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// story #3260 3차 finding(2026-08-31, 선생님 실기기 적발→유나 design 확定) — 모바일 채팅
// 상세(/chats/{id})는 자체 하단 첨부/전송 아이콘 열이 있어 런처(bottom-20 left-5)가 그 위에
// 그대로 겹쳤다(실기기 스크린샷 실증, entity:artifact:13c9e4cb). 리스트(/chats, id 없음)는
// 그 열이 없어 무관 — chats/layout.tsx의 isListRoute = pathname === '/chats' 판정과 대칭.
// 페드루 PO 발주 pin 3종: 모바일 상세=DOM 0 / 모바일 리스트·보드=기존 그대로 / 데스크톱=라우트
// 무관 불변.
describe('SupportWidgetLauncher — story #3260 3차: 모바일 채팅-상세 숨김', () => {
  it('모바일 + 채팅-상세(/chats/conv-123) — 런처 DOM 자체가 없다(겹침 원천 차단)', async () => {
    setInnerWidth(500);
    usePathnameMock.mockReturnValue('/chats/conv-123');
    await mount();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('모바일 + 채팅-리스트(/chats, id 없음) — 기존처럼 bottom-20에 그대로 뜬다', async () => {
    setInnerWidth(500);
    usePathnameMock.mockReturnValue('/chats');
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.className).toContain('bottom-20');
  });

  it('모바일 + 채팅과 무관한 라우트(/board) — 기존처럼 그대로 뜬다(채팅-상세만 예외)', async () => {
    setInnerWidth(500);
    usePathnameMock.mockReturnValue('/board');
    await mount();
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('데스크톱 — 채팅-상세 라우트여도 사이드바 폭+16px 배치가 그대로다(데스크톱은 스플릿뷰라 무관)', async () => {
    setInnerWidth(1280);
    usePathnameMock.mockReturnValue('/chats/conv-123');
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.style.left).toBe('272px'); // 256(기본 사이드바 폭)+16
  });
});
