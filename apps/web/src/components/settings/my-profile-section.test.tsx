// @vitest-environment jsdom
//
// story #3770(페드루 PO 캡처 눈 2026-09-10) — 설정 프로필 「역할」 값이 「관리자」가 아니라
// 원어 키 `admin` 그대로 라이브에 노출됐다(t() 없이 profile.role을 그대로 그린 자리). 이
// 실사고를 그대로 재현·고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('MyProfileSection — 역할 낱말(story #3770 실사고 재현)', () => {
  it('⭐profile.role="admin"이 원어 키 그대로가 아니라 「관리자」로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const fetchWithAuthMock = vi.fn((url: string) => {
      if (url === '/api/me') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { id: 'm-1', name: '홍길동', email: 'hong@moonklabs.com', type: 'human', role: 'admin' } }),
        });
      }
      if (url.startsWith('/api/team-members/')) return Promise.resolve({ ok: true, json: async () => ({ data: { avatar_url: null } }) });
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { MyProfileSection: Section } = await import('./my-profile-section');

    await act(async () => { root.render(wrap(<Section />)); });
    await flush();

    expect(container.textContent).toContain('관리자');
    expect(container.textContent).not.toContain('admin');
    vi.doUnmock('@/lib/db/client');
  });

  it('음성대조 — owner/member도 각각 「소유자」/「구성원」으로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn());
    for (const [raw, expected] of [['owner', '소유자'], ['member', '구성원']] as const) {
      const fetchWithAuthMock = vi.fn((url: string) => {
        if (url === '/api/me') {
          return Promise.resolve({
            ok: true,
            json: async () => ({ data: { id: 'm-1', name: '홍길동', email: 'hong@moonklabs.com', type: 'human', role: raw } }),
          });
        }
        if (url.startsWith('/api/team-members/')) return Promise.resolve({ ok: true, json: async () => ({ data: { avatar_url: null } }) });
        return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
      });
      vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
      vi.resetModules();
      const { MyProfileSection: Section } = await import('./my-profile-section');

      const c = document.createElement('div');
      document.body.appendChild(c);
      const r = createRoot(c);
      await act(async () => { r.render(wrap(<Section />)); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

      expect(c.textContent).toContain(expected);
      expect(c.textContent).not.toContain(raw);

      await act(async () => { r.unmount(); });
      c.remove();
      vi.doUnmock('@/lib/db/client');
    }
  });
});
