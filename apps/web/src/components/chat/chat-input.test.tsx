// @vitest-environment jsdom
//
// story #2032 — 채팅 입력 연속성(자동 포커스·대화별 임시저장·ESC 뒤로가기) 회귀가드.
// 순수 헬퍼(멘션/엔티티 파싱)는 기존 chat-input.test.ts가 이미 덮는다 — 이 파일은 그 위에
// 새로 얹은 상호작용(effect·localStorage·keydown 우선순위)을 실 렌더로 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubMatchMedia(coarse: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: coarse } as MediaQueryList));
}

// story #2059(kanban-board.test.tsx)와 동일 패턴 — jsdom/Node의 네이티브 localStorage가
// 이 실행 환경에서 온전치 않아(--localstorage-file 미설정 시 .clear() 등이 없는 스텁으로
// 대체됨) Map 기반 페이크로 통째로 교체한다.
let store: Map<string, string>;
function stubLocalStorage() {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubLocalStorage();
  stubMatchMedia(false); // 기본은 데스크톱(포인터 정밀) — AC1 대상
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

describe('ChatInput — 진입 시 자동 포커스(story #2032 AC1)', () => {
  it('데스크톱(pointer:fine)이면 마운트 직후 textarea에 포커스가 잡힌다', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    expect(document.activeElement).toBe(textarea());
  });

  it('터치 기기(pointer:coarse)면 자동 포커스하지 않는다(소프트 키보드가 화면을 덮는 것 방지)', async () => {
    stubMatchMedia(true);
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    expect(document.activeElement).not.toBe(textarea());
  });
});

describe('ChatInput — 대화별 임시저장(story #2032 AC2/AC3/AC6)', () => {
  it('마운트 시 그 대화의 저장된 초안을 복원한다(AC2)', async () => {
    window.localStorage.setItem('sprintable:chat-draft:c1', '쓰던 내용');
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    expect(textarea().value).toBe('쓰던 내용');
  });

  it('타이핑하면 그 대화 슬롯에 자동저장된다(AC2)', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    await act(async () => {
      const el = textarea();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(el, '작성 중');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(window.localStorage.getItem('sprintable:chat-draft:c1')).toBe('작성 중');
  });

  it('대화별로 분리된다 — A 대화 초안이 B 대화에 나타나지 않는다(AC3)', async () => {
    window.localStorage.setItem('sprintable:chat-draft:conv-A', 'A 대화 초안');
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="conv-B" onSend={vi.fn()} />));
    });
    expect(textarea().value).toBe(''); // B에는 A의 초안이 안 보임
    expect(window.localStorage.getItem('sprintable:chat-draft:conv-A')).toBe('A 대화 초안'); // A 것은 그대로 보존
  });

  it('메시지를 전송하면 그 대화의 임시저장이 비워진다(AC6)', async () => {
    window.localStorage.setItem('sprintable:chat-draft:c1', '보낼 내용');
    const onSend = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={onSend} />));
    });
    const sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.querySelector('svg') && !b.hasAttribute('aria-haspopup'));
    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith('보낼 내용', undefined, undefined);
    expect(window.localStorage.getItem('sprintable:chat-draft:c1')).toBeNull();
  });
});

describe('ChatInput — ESC 우선순위(story #2032 AC4/AC5)', () => {
  it('아무 오버레이도 안 열려 있으면 ESC가 onEscape를 부른다(AC4)', async () => {
    const onEscape = vi.fn();
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} onEscape={onEscape} />));
    });
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('멘션 후보가 열려 있으면 ESC는 그 후보를 먼저 닫고 onEscape는 안 부른다(AC5)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'm1', name: '오르테가' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const onEscape = vi.fn();
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} onEscape={onEscape} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '@오');
      el.selectionStart = 2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 멘션 fetch가 resolve될 시간을 준다.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[role="listbox"]')).not.toBeNull(); // 후보가 실제로 떠 있음(전제 확認)

    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onEscape).not.toHaveBeenCalled(); // 후보 우선 — 대화 밖으로 안 나감
  });
});
