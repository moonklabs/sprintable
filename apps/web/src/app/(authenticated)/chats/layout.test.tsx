// @vitest-environment jsdom
//
// story #2921 S1(D04 처방 골격) — 영구 스플릿뷰 shell 회귀가드. ChatListView 내부(SSE·fetch
// 등)는 자기 테스트(chat-list-view.test.tsx)가 이미 잰다 — 여기는 이 layout이 실제로 잰다고
// «주장»하는 것(①ChatListView 단일 마운트 ②경로별 반응형 클래스 토글 ③새 대화 버튼 배선)만
// 좁게 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import ChatsLayout from './layout';
import { useChatRail } from './chat-rail-context';

const useDashboardContextMock = vi.fn();
vi.mock('../../dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

const usePathnameMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}));

// story #2921 — ChatListView 자체 로직(SSE·fetch·모달 내부)은 스코프 밖. open/onOpenChange를
// 그대로 받는지만 확認하는 얕은 스텁.
vi.mock('@/components/chat/chat-list-view', () => ({
  ChatListView: ({ open }: { open?: boolean }) => (
    <div data-testid="chat-list-view">chat-list-view(open={String(open)})</div>
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

// story #2921 S6 — jsdom엔 matchMedia가 없다. `mqMatches`를 테스트별로 바꿔 xl 미만/이상을
// 흉내낸다(리스너도 실제로 등록·해제해 useEffect cleanup 누락을 놓치지 않게).
let mqMatches = false;
const mqListeners = new Set<() => void>();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-1', projectId: 'proj-1' });
  mqMatches = false;
  mqListeners.clear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: mqMatches,
    media: query,
    addEventListener: (_: string, cb: () => void) => { mqListeners.add(cb); },
    removeEventListener: (_: string, cb: () => void) => { mqListeners.delete(cb); },
  })) as unknown as typeof window.matchMedia;
});

// story #2921 S6 테스트 전용 — ChatView 대신 심어 chat-rail-context의 setReadingOpen을 직접
// 호출한다(실 ChatView는 SSE를 물어 이 파일 스코프 밖, chat-view.tsx 자체 책임은 그 파일이 아니라
// 여기 layout+context 배선만 검증).
function ReadingOpenProbe({ open }: { open: boolean }) {
  const { setReadingOpen } = useChatRail();
  useEffect(() => { setReadingOpen(open); }, [open, setReadingOpen]);
  return <div data-testid="outlet-content">outlet</div>;
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('ChatsLayout — story #2921 S1(영구 스플릿뷰 shell)', () => {
  it('ChatListView는 정확히 1곳만 마운트된다(리스트 경로·대화 경로 둘 다 — 이중 구독 방지가 이 story의 핵심 근거)', async () => {
    usePathnameMock.mockReturnValue('/chats');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div>children</div></ChatsLayout>));
    });
    expect(container.querySelectorAll('[data-testid="chat-list-view"]')).toHaveLength(1);
  });

  it('/chats(리스트 경로) — 레일은 모바일에서도 보이고(lg 무관 flex), outlet은 모바일에서 숨는다(hidden)', async () => {
    usePathnameMock.mockReturnValue('/chats');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div data-testid="outlet-content">outlet</div></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    const outlet = container.querySelector('[data-testid="chat-outlet"]');
    expect(rail?.className).toContain('flex');
    expect(rail?.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(outlet?.className).toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('/chats/[id](대화 경로) — outlet은 모바일에서도 보이고, 레일은 모바일에서 숨는다(현행 라우트 전환 유지)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div data-testid="outlet-content">outlet</div></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    const outlet = container.querySelector('[data-testid="chat-outlet"]');
    expect(rail?.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(outlet?.className).toContain('flex');
    expect(outlet?.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('두 경로 다 lg:flex(데스크톱 항상 병렬)를 갖는다 — 반응형 토글은 모바일 전용', async () => {
    for (const pathname of ['/chats', '/chats/conv-123']) {
      usePathnameMock.mockReturnValue(pathname);
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await act(async () => {
        root.render(wrap(<ChatsLayout><div data-testid="outlet-content">outlet</div></ChatsLayout>));
      });
      const rail = container.querySelector('[data-testid="chat-rail"]');
      const outlet = container.querySelector('[data-testid="chat-outlet"]');
      expect(rail?.className).toContain('lg:flex');
      expect(outlet?.className).toContain('lg:flex');
    }
  });

  it('「새 대화」버튼 클릭 시 ChatListView에 open=true가 전달된다(모달 배선 회귀 0)', async () => {
    usePathnameMock.mockReturnValue('/chats');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div>children</div></ChatsLayout>));
    });
    expect(container.querySelector('[data-testid="chat-list-view"]')!.textContent).toContain('open=false');
    const newConvBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('새 대화') || b.textContent?.includes('New'));
    expect(newConvBtn).toBeTruthy();
    await act(async () => { newConvBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[data-testid="chat-list-view"]')!.textContent).toContain('open=true');
  });
});

describe('ChatsLayout — story #2921 S6(xl 미만 + Reading 열림 → rail 자동 접힘, 유나 확定)', () => {
  it('xl↑(넓은 폭)에서는 Reading이 열려도 rail이 절대 안 접힌다(①rail 절대 불변)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = false; // matchMedia('(max-width: 1279px)') 불일치 = xl↑
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open /></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    expect(rail?.className).not.toMatch(/(^|\s)lg:hidden(\s|$)/);
    // 카디르 #3337 QA 처방(포커스 복귀 버그) 후 — 트리거는 이제 항상 마운트되고 CSS로만
    // 숨는다(DOM 부재가 아니라 !hidden 클래스). 존재 자체가 아니라 숨김 클래스를 잰다.
    expect(container.querySelector('[aria-label="목록 열기"]')?.className).toContain('!hidden');
  });

  it('lg~xl 사이 + Reading 닫힘 — 현행 2-pane 그대로(무변화, ②)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = true; // xl 미만
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open={false} /></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    expect(rail?.className).not.toMatch(/(^|\s)lg:hidden(\s|$)/);
  });

  it('lg~xl 사이 + Reading 열림 — rail이 자동 접히고(③) 재호출 토글이 뜬다', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = true;
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open /></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    expect(rail?.className).toMatch(/(^|\s)lg:hidden(\s|$)/);
    const expandBtn = container.querySelector('[aria-label="목록 열기"]');
    expect(expandBtn).toBeTruthy();
    expect(expandBtn?.className).not.toContain('!hidden');
  });

  it('접힌 rail을 토글로 다시 부르면 오버레이(fixed)로 뜬다 — main/reading 폭을 다시 누르지 않는다(④)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = true;
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open /></ChatsLayout>));
    });
    const expandBtn = container.querySelector('[aria-label="목록 열기"]') as HTMLButtonElement;
    await act(async () => { expandBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    expect(rail?.className).toContain('fixed');
    expect(rail?.className).toContain('z-40');
    // story #2921 S6 후속(PO dev 라이브 실측, 2026-08-22) — 오버레이 rail에 배경이 없어
    // 뒤 GNB 텍스트가 그대로 비쳐 가독을 깼다(docked 상태는 뒤에 아무것도 없어 안 보였다).
    // 불투명 배경+테두리 회귀가드.
    expect(rail?.className).toContain('bg-background');
    expect(rail?.className).toContain('border-border');
    // 오버레이 상태에선 collapsed 전용 재호출 토글이 !hidden으로 숨고(DOM 부재 아님 — 카디르
    // #3337 QA 처방, 포커스 복귀 안정성), backdrop이 대신 뜬다(장식용 click-catcher —
    // 접근성 트리에서는 빠진다, aria-hidden).
    expect(container.querySelector('[aria-label="목록 열기"]')?.className).toContain('!hidden');
    const backdrop = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('aria-hidden') === 'true');
    expect(backdrop).toBeTruthy();
  });

  it('오버레이는 접근 가능한 dialog다 — rail 자체가 role="dialog"+aria-modal+aria-labelledby를 지닌다(CI a11y 가드 처방)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = true;
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open /></ChatsLayout>));
    });
    const expandBtn = container.querySelector('[aria-label="목록 열기"]') as HTMLButtonElement;
    await act(async () => { expandBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    expect(rail?.getAttribute('role')).toBe('dialog');
    expect(rail?.getAttribute('aria-modal')).toBe('true');
    expect(rail?.getAttribute('aria-labelledby')).toBe('chat-rail-heading');
    expect(container.querySelector('#chat-rail-heading')).toBeTruthy();
  });

  it('평소(collapsed 아닌 정상 상태)엔 rail이 dialog 시맨틱을 안 지닌다(항상 열려있는 걸 모달이라 우기지 않는다)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = false;
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open={false} /></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    expect(rail?.getAttribute('role')).toBeNull();
    expect(rail?.getAttribute('aria-modal')).toBeNull();
  });

  it('Reading이 닫히면 수동 펼침 상태도 리셋된다(다음에 다시 열릴 때 자동접힘부터 재시작)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = true;
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open /></ChatsLayout>));
    });
    const expandBtn = container.querySelector('[aria-label="목록 열기"]') as HTMLButtonElement;
    await act(async () => { expandBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[data-testid="chat-rail"]')?.className).toContain('fixed');
    // Reading 닫힘 → Provider가 그대로 유지된 채(같은 root) props만 바꿔 재렌더 — 실제 앱에서
    // ChatView가 readingPanelStack 변화로 setReadingOpen을 다시 부르는 것과 동형.
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open={false} /></ChatsLayout>));
    });
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open /></ChatsLayout>));
    });
    // 리셋됐다면 다시 collapsed(재호출 토글이 !hidden 없이 보임)로 돌아온다 — overlay가 안 남아있다.
    expect(container.querySelector('[aria-label="목록 열기"]')?.className).not.toContain('!hidden');
    expect(container.querySelector('[data-testid="chat-rail"]')?.className).not.toContain('fixed');
  });

  it('카디르 #3337 QA(2026-08-22, HIGH) — Escape로 오버레이를 닫으면 포커스가 트리거로 정확히 돌아온다(숨겨진 rail 안 다른 버튼으로 새지 않는다)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    mqMatches = true;
    await act(async () => {
      root.render(wrap(<ChatsLayout><ReadingOpenProbe open /></ChatsLayout>));
    });
    const expandBtn = container.querySelector('[aria-label="목록 열기"]') as HTMLButtonElement;
    expandBtn.focus();
    await act(async () => { expandBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 트리거가 언마운트되지 않고 !hidden으로만 숨는다 — DOM에 여전히 있다(포커스 복귀 대상이
    // 살아있어야 하는 이 처방의 핵심 전제).
    expect(expandBtn.isConnected).toBe(true);
    expect(expandBtn.className).toContain('!hidden');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(expandBtn);
    expect(expandBtn.className).not.toContain('!hidden');
  });
});
