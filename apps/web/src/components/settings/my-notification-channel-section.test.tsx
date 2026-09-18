// @vitest-environment jsdom
//
// story #3519(§16-7 2부, PO 確定 2026-09-05) — projRes만 격리(.catch)돼 있고 meRes는
// 안 돼 있었다. meRes가 네트워크단 reject하면 Promise.all 전체가 던져(destructuring
// 자체가 실패) 이미 정상 응답한 projRes의 결과(nameMap)까지 못 반영됐을 뿐 아니라,
// 호출부가 `void load()`(fire-and-forget, .catch 없음)라 그 예외가 처리되지 않은
// promise rejection으로 새 나갔다 — 브라우저 전역 unhandledrejection(에러 모니터링
// 노이즈)로 이어지는 클래스. 한쪽만 격리하면 격리 자체가 무의미해진다는 걸 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { MyNotificationChannelSection } from './my-notification-channel-section';

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('MyNotificationChannelSection — meRes/projRes 격리(story #3519)', () => {
  it('/api/me가 네트워크 reject해도 처리되지 않은 promise rejection이 새지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') throw new Error('network down');
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '프로젝트 A' }] }) };
      return { ok: false, json: async () => null };
    }));

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await act(async () => {
        root.render(wrap(<MyNotificationChannelSection projectId="proj-1" projectName="프로젝트 A" />));
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      // 마이크로태스크 큐가 완전히 비워질 시간을 한 틱 더 준다(unhandledRejection은
      // 콜스택이 완전히 비고 난 뒤 다음 틱에 발화한다).
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
