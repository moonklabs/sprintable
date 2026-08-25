// @vitest-environment jsdom
//
// story #3053(2984-S5) — 에이전트 선택 버튼 on 상태 회귀가드. subtle 헤어라인(border-proof-
// blue/40+bg-transparent) 채택, bg-proof-blue-soft 채움 폐지(체크박스 solid fill은 기능
// 신호라 무변경).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import { SteerDispatchModal } from './steer-dispatch-modal';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

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
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [{ id: 'a1', name: '디디', type: 'agent', is_active: true }],
    }),
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('SteerDispatchModal — story #3053 에이전트 선택 헤어라인(soft-fill 폐지)', () => {
  it('선택(on) 상태가 bg-transparent를 쓰고 bg-proof-blue-soft는 안 쓴다', async () => {
    await act(async () => {
      root.render(wrap(
        <SteerDispatchModal projectId="proj-1" items={[{ id: 'e1', position: 0 }]} onClose={() => {}} onDispatched={() => {}} />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // story #3053 — Dialog(base-ui)는 document.body에 포탈되므로 container가 아니라
    // document.body에서 찾는다.
    const agentBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('디디'));
    expect(agentBtn).toBeTruthy();
    await act(async () => { agentBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(agentBtn?.className).toContain('bg-transparent');
    expect(agentBtn?.className).not.toContain('bg-proof-blue-soft');
    expect(agentBtn?.className).toContain('border-proof-blue/40');
  });
});
