// @vitest-environment jsdom
//
// story #4231 4차 B(까디르 codex 01a0d3ad ①) — 커맨드 팔레트의 앵커 목적지(GUARD_ANCHOR_ITEMS · 래칫 예외)는 소비처가 flatHref로 감싼다는 것이
// 예외의 전제다. 기존 테스트는 isWorkspaceless만 봐서 소비처의 flatHref를 빼도 초록이었다 — 프로젝트 맥락에서 실제로 가는 주소(`?p=`)를 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ orgId: 'org-1', orgMemberships: [], currentProjectSlug: null, projectId: 'proj-1', projectMemberships: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
  pushMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('CommandPalette — 앵커 목적지는 현재 프로젝트(?p=)를 싣는다(#4231 4차 B)', () => {
  it.each([
    ['스프린트로 이동', '/sprints?p=proj-1'],
    ['회고로 이동', '/retro?p=proj-1'],
  ])('⭐%s → %s', async (label, href) => {
    const { CommandPalette } = await import('./command-palette');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <CommandPalette open onOpenChange={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // story #4380 — 항목 = Autocomplete option(div role="option" · 버튼이면 입력칸 초점을 뺏는다).
    const btn = [...document.querySelectorAll('[role="option"]')].find((b) => b.textContent?.includes(label));
    expect(btn).toBeDefined();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith(href);
  });
});

// story 4892 (D1) — a document picked from the palette opens to READ; when the workspace/project slugs are not known yet the address is the FLAT form, whose project query
// comes AFTER the path (`/docs/{slug}/view?p=…`) — never inside it (`/docs?p=…/{slug}/view` was a broken address).
describe('CommandPalette — 문서 결과(flat 폴백)는 경로 뒤에 ?p=를 싣는다 (story 4892)', () => {
  it('⭐slug를 모를 때: /docs/{slug}/view?p=proj-1', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/api/docs?')
        ? { ok: true, status: 200, json: async () => ({ data: [{ id: 'd1', title: '결제 스펙 v2', slug: 'payments-v2' }] }) }
        : { ok: true, status: 200, json: async () => ({ data: [] }) })));
      const { CommandPalette } = await import('./command-palette');
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <CommandPalette open onOpenChange={vi.fn()} projectId="proj-1" />
          </NextIntlClientProvider>,
        );
      });
      const input = document.querySelector('input') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '결제');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('결제 스펙 v2'));
      expect(opt, 'the document result').toBeTruthy();
      await act(async () => { opt!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledWith('/docs/payments-v2/view?p=proj-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
