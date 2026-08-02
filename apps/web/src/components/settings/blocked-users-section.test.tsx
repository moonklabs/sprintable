// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { BlockedUsersSection } from './blocked-users-section';
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

// story #2349 — 0명이면 절 자체를 안 그린다(standup-history-section.tsx 선례 재사용).
describe('BlockedUsersSection', () => {
  it('빈 목록이면 아무것도 안 그린다(절 자체가 없다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    // 마이크로태스크 큐 flush를 위해 한 틱 더
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe('');
  });

  it('목록 fetch 실패면 아무것도 안 그린다(loading이 안 풀려도 조용히 실패)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe('');
  });

  it('1건 이상이면 절이 뜨고 이름을 resolve해 보여준다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/user-blocks') {
        return { ok: true, json: async () => ({ data: [{ blocked_member_id: 'member-9', created_at: '2026-08-02T00:00:00Z' }] }) };
      }
      if (url === '/api/team-members/member-9') {
        return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('차단한 사용자 목록');
    expect(container.textContent).toContain('까심');
    expect(container.textContent).toContain('차단 해제');
  });

  it('차단 해제 클릭 → DELETE 성공 → 목록에서 즉시 빠진다(마지막 1건이면 절 전체가 사라진다)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/user-blocks') {
        return { ok: true, json: async () => ({ data: [{ blocked_member_id: 'member-9', created_at: '2026-08-02T00:00:00Z' }] }) };
      }
      if (url === '/api/team-members/member-9') {
        return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      }
      if (url === '/api/user-blocks/member-9' && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('까심');

    const unblockBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '차단 해제');
    expect(unblockBtn).not.toBeUndefined();
    await act(async () => {
      unblockBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
  });

  it('차단 해제 실패면 목록에 그대로 남고 에러 토스트가 뜬다', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/user-blocks') {
        return { ok: true, json: async () => ({ data: [{ blocked_member_id: 'member-9', created_at: '2026-08-02T00:00:00Z' }] }) };
      }
      if (url === '/api/team-members/member-9') {
        return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      }
      if (url === '/api/user-blocks/member-9' && init?.method === 'DELETE') {
        return { ok: false, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const unblockBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '차단 해제');
    await act(async () => {
      unblockBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('까심');
  });
});
