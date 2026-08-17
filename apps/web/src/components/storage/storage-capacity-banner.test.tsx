// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StorageCapacityBanner } from './storage-capacity-banner';

const useDashboardContextMock = vi.fn();
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({
    orgId: 'org-1',
    orgMemberships: [{ orgId: 'org-1', role: 'admin' }],
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// story #2513 — 카디르 QA 발견: alert.tsx 글자가 text-foreground로 통일된 후, 색을
// 명시하지 않은 아이콘(AlertOctagon, destructive/block 분기)은 부모의 currentColor를
// 상속해 variant 색(destructive)을 잃는다.
describe('StorageCapacityBanner — 아이콘 색 유지 (story #2513 회귀가드)', () => {
  it('100%(block/destructive) — AlertOctagon 아이콘이 text-destructive를 갖는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { used_bytes: 100, limit_bytes: 100, percentage: 100 } }) })),
    );
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <StorageCapacityBanner />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    const icon = alertEl?.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-destructive');
  });
});

// story #2689(콜드 재진입 슬로우) — raw fetch였을 때는 마운트 시 401을 맞으면 재시도 없이
// `if (!res.ok) return`으로 조용히 삼켜(폴링도 없는 마운트 1회뿐) 배너가 영원히 안 떴다.
// fetchWithAuth로 바꾼 뒤엔 401→refresh→재시도 경로를 타 결국 뜬다 — 이 축을 고정한다.
describe('StorageCapacityBanner — 콜드 재진입(401→refresh→재시도) 후 배너가 뜬다(story #2689)', () => {
  it('첫 요청이 401이어도 fetchWithAuth의 refresh 재시도로 결국 배너가 렌더된다', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/auth/refresh')) {
        return new Response(JSON.stringify({ data: { access_token: 'new-at', refresh_token: 'new-rt', token_type: 'bearer' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      callCount += 1;
      if (callCount === 1) return new Response(null, { status: 401 });
      return new Response(JSON.stringify({ data: { used_bytes: 100, limit_bytes: 100, percentage: 100 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <StorageCapacityBanner />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
  });
});
