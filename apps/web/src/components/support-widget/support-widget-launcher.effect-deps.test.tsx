// @vitest-environment jsdom
//
// story #3260 2차 finding(2026-08-31, 유나 라이브 실측 FAIL — 재시도 스톰) — 근본원인은
// launcher의 mount effect가 `[open, session]` deps였던 것: session(useSupportWidgetSession()
// 반환 객체)이 status 변화마다 새 참조가 되므로, session 참조가 바뀔 때마다 effect가
// 재발화해 connect()를 다시 불렀다. support-widget-launcher.test.tsx의 호출횟수 pin은 이걸
// 실 훅+1초 백오프 조합으로 검증하는데, 백오프가 "session이 바뀌어도 재호출이 실제
// side-effect(state 변화)를 안 내면 추가 재발화가 없다"는 우연한 상호작용으로 재시도를
// 가려버려(리버트해서 직접 확認 — 효과 deps를 되돌려도 백오프만으로 이 테스트는 green이었다),
// 이 fix 자체를 단독으로 겨냥하는 회귀가드가 못 된다. 이 파일은 그 갭을 닫는다 — 훅을
// 통째로 목해 매 렌더 새 session 객체를 강제로 만들어내고(백오프 로직 자체가 실행되지
// 않음), 그 상태에서 connect가 몇 번 불리는지를 직접 잰다. deps가 [open, session]으로
// 되돌아가면 이 테스트가 렌더 횟수만큼 connect가 불려 반드시 red가 된다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SidebarProvider } from '@/components/ui/sidebar';
import { _resetActivationStatusCacheForTests } from '@/hooks/use-activation-status';
import type { SupportWidgetSession } from '@/hooks/use-support-widget-session';
import { SupportWidgetLauncher } from './support-widget-launcher';

const connectMock = vi.fn();
let renderCount = 0;

vi.mock('@/hooks/use-support-widget-session', () => ({
  // 매 호출마다 새 객체 리터럴 — 실 훅이 status 변화 시 하던 것과 동일한 "참조 불안정"을
  // 무조건 재현한다(백오프·async 타이밍 전부 우회, effect deps 자체만 겨냥). vi.mock은
  // vitest가 파일 최상단으로 호이스트하므로 이 아래의 static import보다 먼저 적용된다.
  useSupportWidgetSession: (): SupportWidgetSession => {
    renderCount += 1;
    return {
      status: 'error',
      messages: [],
      escalationStatus: null,
      conversationId: null,
      isEnded: false,
      conversations: null,
      sending: false,
      sendError: null,
      connect: connectMock,
      sendMessage: vi.fn(async () => {}),
      retryLastMessage: vi.fn(),
      startNewConversation: vi.fn(async () => {}),
      endConversation: vi.fn(async () => {}),
      selectConversation: vi.fn(async () => {}),
      viewActiveConversation: vi.fn(async () => {}),
      loadConversations: vi.fn(async () => {}),
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connectMock.mockReset();
  renderCount = 0;
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  // story #3274 — 런처가 이제 useActivationStatus()도 부른다(온보딩 단계 게이팅). 이 파일의
  // 관심사는 effect deps 회귀 하나뿐이라, activation 조회는 "미완주"(런처가 뜨는 쪽)로
  // 고정해 무관 변수로 만든다 — 캐시도 파일 간/테스트 간 새지 않게 리셋.
  _resetActivationStatusCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: {
      steps: { signed_up: true, email_verified: false, org_created: false, agent_connected: false, first_roundtrip: false },
      completed: 1, total: 5, all_complete: false, first_instruction_conversation_id: null,
    } }),
  })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SidebarProvider>
          <SupportWidgetLauncher />
        </SidebarProvider>
      </NextIntlClientProvider>,
    );
  });
}

describe('SupportWidgetLauncher — mount effect는 session 참조 변경에 반응하지 않는다(회귀가드)', () => {
  it('open 그대로인 채 session이 매 렌더 새 참조여도(훅을 통째로 목해 강제 재현) connect는 딱 1번만 불린다', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // open
    const rendersAfterOpen = renderCount;
    expect(rendersAfterOpen).toBeGreaterThan(0);

    // open을 그대로 둔 채 강제로 여러 번 더 렌더시킨다(부모 재렌더 시뮬레이션) — 매번
    // useSupportWidgetSession()이 다시 불려 새 session 객체가 나온다(목의 설계 그대로).
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <SidebarProvider>
              <SupportWidgetLauncher />
            </SidebarProvider>
          </NextIntlClientProvider>,
        );
      });
    }
    expect(renderCount).toBeGreaterThan(rendersAfterOpen); // 실제로 더 렌더됐다(테스트 유효성 확認)
    expect(connectMock).toHaveBeenCalledTimes(1); // effect deps가 [open]이라 재발화 없음
  });
});
