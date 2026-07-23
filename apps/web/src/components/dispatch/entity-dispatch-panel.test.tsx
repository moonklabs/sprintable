// @vitest-environment jsdom
//
// 까심군 QA 회귀(2026-07-21) — /api/dispatch가 apiSuccess()로 {data:{dispatched,...}}를
// 감싸는데 패널이 flat({dispatched})으로 읽어 서버가 200 성공을 반환해도 매번 "담당자
// 미지정" 토스트가 떴다(4/4 재현, dispatched는 항상 undefined). RED→GREEN으로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EntityDispatchPanel } from './entity-dispatch-panel';
import koMessages from '../../../messages/ko.json';

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

const MEMBERS = [{ id: 'm1', name: '홍길동', type: 'human' as const, is_active: true }];

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

describe('EntityDispatchPanel — 까심군 QA 회귀 (envelope unwrap)', () => {
  it('/api/dispatch가 {data:{dispatched:true}}로 응답하면 성공 토스트가 뜬다(담당자 미지정 오탐 아님)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      if (url === '/api/dispatch') {
        // 실제 서버 계약 — apiSuccess()가 감싼 shape 그대로.
        return { ok: true, json: async () => ({ data: { dispatched: true, assignee_id: 'm1', reason: 'ok' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId="m1" />,
      ));
    });
    // 담당자 select가 members fetch 이후 채워질 때까지 한 틱 더.
    await act(async () => { await Promise.resolve(); });

    const dispatchBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('전달'));
    await act(async () => {
      dispatchBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('담당자가 지정되지 않았습니다');
    expect(document.body.textContent).toContain('전달했습니다');
  });

  it('/api/dispatch가 {data:{dispatched:false}}면(진짜 담당자 미지정) 안내 토스트가 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      if (url === '/api/dispatch') {
        return { ok: true, json: async () => ({ data: { dispatched: false, reason: 'no_assignee' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId="m1" />,
      ));
    });
    await act(async () => { await Promise.resolve(); });

    const dispatchBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('전달'));
    await act(async () => {
      dispatchBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('담당자가 지정되지 않았습니다');
  });
});
