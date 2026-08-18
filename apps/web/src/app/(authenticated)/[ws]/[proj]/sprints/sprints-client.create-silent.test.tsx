// @vitest-environment jsdom
//
// story #2755 — fresh 조직의 첫 스프린트 시작이 «무설명 무반응»이던 결함의 «표시»를 테스트한다:
// ①날짜 2칸이 pre-fill되어 fresh 유저가 빈 날짜 벽에 안 막힌다 ②미충족(이름/가설) 상태로
// 「스프린트 시작」을 클릭하면 «조용한 no-op»이 아니라 사유 메시지가 화면에 뜨고, /api/sprints
// POST는 나가지 않는다(무설명 무반응 → 명시 no-submit). 훅이 아니라 렌더 결과/네트워크로 확認.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

// HypothesisDeclarationSection·CreateDialog가 쓰는 fetchWithAuth — 가설 목록은 빈 배열로.
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function sprintsPosted(): boolean {
  return fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/sprints'));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { id: 'sp-1' } }), text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  const { CreateDialog } = await import('./sprints-client');
  await act(async () => {
    root.render(wrap(<CreateDialog projectId="proj-1" onCreated={() => {}} onClose={() => {}} />));
  });
  // 마운트 직후 가설 목록 fetch 등 microtask flush
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function activateButton(): HTMLButtonElement {
  const label = koMessages.sprints.activate; // '스프린트 시작'
  const btn = [...document.body.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label);
  if (!btn) throw new Error('activate 버튼을 찾지 못함');
  return btn as HTMLButtonElement;
}

async function clickActivate() {
  await act(async () => { activateButton().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('CreateDialog — 첫 스프린트 시작 침묵 금지 (story #2755)', () => {
  it('시작일·종료일이 pre-fill되어 빈 날짜 벽이 사라진다', async () => {
    await mount();
    const dates = [...document.body.querySelectorAll('input[type=date]')] as HTMLInputElement[];
    expect(dates.length).toBe(2);
    expect(dates[0]!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/); // startDate
    expect(dates[1]!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/); // endDate
    expect(dates[1]!.value > dates[0]!.value).toBe(true);   // 종료 > 시작
  });

  it('이름 없이 「스프린트 시작」 클릭 → 무설명 no-op이 아니라 missingRequired가 뜨고 POST 미발화', async () => {
    await mount();
    // 기본 상태: 이름 빈칸·날짜 pre-fill·가설 0
    await clickActivate();
    expect(document.body.textContent).toContain(koMessages.sprints.missingRequired);
    expect(sprintsPosted()).toBe(false);
  });

  it('이름+기본날짜 있으나 가설 0개로 「스프린트 시작」 클릭 → activateBlocked가 뜨고 POST 미발화(게이트 유지)', async () => {
    await mount();
    const titleInput = document.body.querySelector('input[type=text]') as HTMLInputElement;
    await act(async () => { setNativeValue(titleInput, '스프린트 1'); });
    await clickActivate();
    expect(document.body.textContent).toContain(koMessages.sprints.activateBlocked);
    expect(sprintsPosted()).toBe(false);
  });
});
