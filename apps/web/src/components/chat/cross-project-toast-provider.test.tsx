// @vitest-environment jsdom
//
// story #2168 PR-② 후속 — CrossProjectToastProvider가 layout 레벨에 상주해 네비게이션(pathname
// 변경)을 넘어 대기 중인 토스트를 소비하는지 고정한다. 라이브 실측 발견: ChatListView 자체의
// 로컬 토스트는 클릭 직후 router.push로 언마운트되며 화면에 페인트될 새 없이 사라졌다 — 이
// provider가 그 자리를 대신한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CrossProjectToastProvider, queuePendingToast } from './cross-project-toast-provider';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/chats' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
  pathnameRef.current = '/chats';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(wrap(<CrossProjectToastProvider><div>content</div></CrossProjectToastProvider>));
  });
}

async function rerenderAtPathname(pathname: string) {
  pathnameRef.current = pathname;
  await act(async () => {
    root.render(wrap(<CrossProjectToastProvider><div>content</div></CrossProjectToastProvider>));
  });
}

describe('CrossProjectToastProvider — 네비게이션 생존 토스트 (story #2168 PR-② 후속)', () => {
  it('큐잉된 토스트가 없으면 아무것도 안 뜬다', async () => {
    await mount();
    expect(container.textContent).toBe('content');
  });

  it('pathname이 바뀌면(=도착) 큐잉된 토스트를 소비해 띄우고 sessionStorage를 비운다', async () => {
    queuePendingToast('sprintable 프로젝트로 이동');
    await mount(); // 최초 마운트도 pathname 변경으로 취급(useEffect 최초 실행)
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('sprintable 프로젝트로 이동');
    expect(sessionStorage.getItem('sprintable_pending_toast')).toBeNull();
  });

  // 참고: consumedRef 가드(React StrictMode의 effect 이중 호출 방어)는 이 테스트 하네스로는
  // 판별력 있게 재현이 안 된다(mutation 확認 결과 — 가드를 지워도 이 harness의 "같은 pathname
  // 재렌더"는 애초에 useEffect를 재실행하지 않아 실패하지 않았다·React 자체의 의존성 배열
  // 메커니즘이 이미 그 경로를 막는다). 그래서 "판별력 없는 초록 테스트"로 남기지 않고 뺐다 —
  // 가드 자체는 StrictMode 이중 마운트 대비로 구조상 유지한다.

  it('다음 페이지에서 새 토스트가 큐잉되면(pathname 변경) 그건 소비한다', async () => {
    queuePendingToast('A 프로젝트로 이동');
    await mount();
    await act(async () => { await Promise.resolve(); });

    queuePendingToast('B 프로젝트로 이동');
    await rerenderAtPathname('/chats/conv-2');
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('B 프로젝트로 이동');
  });
});
