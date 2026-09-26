// @vitest-environment jsdom
// [SID:4311 PR 3] 게이트 활동 줄의 행위자 — 같은 이름 서로 다른 구성원 둘이면 «· ID 앞 8자»(행위자 id마다 한 번 · 불러온 줄 안에서만) ·
// 이름 빔은 기존 폴백 그대로(story #2975 — 응답이 떠난 사람과 이름 없는 사람을 가르지 않음) · 폴백 둘도 서로 다른 id면 꼬리.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

import { GateActivityHistory } from './gate-evidence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); fetchWithAuthMock.mockReset(); });

const item = (id: string, actor_id: string | null, actor_name: string | null) => ({
  id, action: 'gate_approved', actor_id, actor_name, context: {}, created_at: '2026-09-25T00:00:00Z',
});

describe('GateActivityHistory — 행위자 동명이인([SID:4311 PR 3])', () => {
  it('«송윤재» 둘 = 줄마다 id 앞 8자 · 같은 사람 두 줄 = 같은 꼬리 · 이름 빔 = 기존 폴백 · 행위자 없음 = 기존 폴백(꼬리 없음)', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => [
      item('a1', 'e75ca548-1', '송윤재'),
      item('a2', '2fd14616-2', '송윤재'),
      item('a3', 'm-anna', '안나'),
      item('a4', 'e75ca548-1', '송윤재'),
      item('a5', 'm-unnamed', null),
      item('a6', null, null),
    ] });
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><GateActivityHistory gateId="g1" /></NextIntlClientProvider>);
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    const actors = [...container.querySelectorAll('li > span.font-medium')].map((el) => el.textContent);
    expect(actors).toEqual([
      '송윤재 · e75ca548', '송윤재 · 2fd14616', '안나', '송윤재 · e75ca548',
      koMessages.cage.gateActivityActorFallback, koMessages.cage.gateActivityActorFallback,
    ]);
  });
});
