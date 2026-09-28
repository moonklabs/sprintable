// @vitest-environment jsdom
//
// [SID:4379] 설정 › 알림의 이벤트 행마다 «앱 내» 토글이 스위치 모양(rounded-full h-6 w-11)인데 role=switch · aria-checked가
// 없어, 화면 읽기에 «단추»만 들리고 지금 켜졌는지 몰랐다. 스위치마다 role="switch" + aria-checked = 그 행의 켜짐 값이고,
// 누르면 값이 따라 뒤집히며, 저장이 실패해 되돌아가면 aria-checked도 되돌아간다(보이는 것과 읽히는 것이 같다).
// 유나(1b6cc9988 CHANGES): 스위치 이름 = 행 이름(이벤트) + «앱 내» 열 머리(aria-labelledby · 새 글 0) — «(이벤트) 앱 내, 스위치, 켬».
// PO: 같은 화면 «기본 알림 레벨»(전체 · 멘션만 · 끄기)은 하나 고르기 — 고른 값을 aria-pressed로.
// 틀은 notification-default-level.test.tsx와 같다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { RefreshProvider } from '@/contexts/refresh-context';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=notifications'),
  usePathname: () => '/settings',
}));

// 서버 값: «태스크 배정»만 꺼짐, 나머지는 기록 없음(= 켜짐 기본값 · getEnabled).
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    if (url === '/api/current-project') {
      return { ok: true, json: async () => ({ data: { project_id: 'proj-1', org_id: 'org-1' } }) };
    }
    if (url === '/api/notification-settings') {
      return { ok: true, json: async () => ({ data: [{ id: 's-1', channel: 'in_app', event_type: 'task_assigned', enabled: false }] }) };
    }
    return { ok: false, json: async () => ({ data: null }) };
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let putOk = true;
type FetchLike = { ok: boolean; json: () => Promise<unknown> };
const fetchMock = vi.fn(async (): Promise<FetchLike> => ({ ok: putOk, json: async () => ({ data: null }) }));

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <RefreshProvider>{node}</RefreshProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  putOk = true;
  fetchMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [] });
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  // 토글 저장(PUT)은 raw fetch로 간다(toggleSetting).
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(wrap(node)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const labelOf = (eventType: string) => (koMessages.settings as Record<string, string>)[`event_${eventType}`];

// 행 이름(이벤트 글) 옆의 «앱 내» 토글 — 역할 속성에 기대지 않고 행 구조로 찾는다(옛 코드에서도 찾아 RED가 나게).
function inAppToggle(eventType: string): HTMLButtonElement {
  const label = [...container.querySelectorAll('span')].find((s) => s.textContent?.trim() === labelOf(eventType));
  const btn = label?.parentElement?.querySelector('button');
  if (!btn) throw new Error(`«앱 내» 토글을 못 찾음: ${eventType}`);
  return btn;
}

// aria-labelledby의 id들이 실제로 풀린 글(없는 id는 ∅) — 읽히는 이름.
function nameOf(el: HTMLElement): string {
  return (el.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '∅')
    .join(' ');
}

async function click(el: HTMLElement) {
  await act(async () => { el.click(); await Promise.resolve(); await Promise.resolve(); });
}

describe('설정 알림 «앱 내» 토글 = 스위치([SID:4379])', () => {
  it('행마다 role="switch" + aria-checked = 그 행의 켜짐 값(서버 꺼짐 → false · 기록 없음 → true)', async () => {
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    const off = inAppToggle('task_assigned');
    const on = inAppToggle('story');
    expect(off.getAttribute('role')).toBe('switch');
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(on.getAttribute('role')).toBe('switch');
    expect(on.getAttribute('aria-checked')).toBe('true');
    // 보이는 켜짐(손잡이 색)과 읽히는 값이 같은 행 값에서 나온다.
    expect(on.className).toContain('bg-primary');
    expect(off.className).not.toContain('bg-primary');
  });

  it('누르면 aria-checked가 뒤집히고 저장 값도 같다', async () => {
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    await click(inAppToggle('task_assigned'));
    expect(inAppToggle('task_assigned').getAttribute('aria-checked')).toBe('true');
    const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ channel: 'in_app', event_type: 'task_assigned', enabled: true });
  });

  it('저장이 실패해 되돌아가면 aria-checked도 되돌아간다', async () => {
    putOk = false;
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    await click(inAppToggle('story'));
    expect(fetchMock).toHaveBeenCalled();
    expect(inAppToggle('story').getAttribute('aria-checked')).toBe('true');
  });

  it('스위치 이름 = 그 행 이벤트 이름 + «앱 내»(유나) — 행끼리 이름이 다르다', async () => {
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    const inApp = koMessages.settings.notification_channel_in_app;
    expect(nameOf(inAppToggle('task_assigned'))).toBe(`${labelOf('task_assigned')} ${inApp}`);
    expect(nameOf(inAppToggle('story'))).toBe(`${labelOf('story')} ${inApp}`);
    const names = [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].map(nameOf);
    expect(names.length).toBeGreaterThan(1);
    for (const n of names) expect(n).not.toContain('∅');
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('«기본 알림 레벨» = 하나 고르기(PO · [SID:4379])', () => {
  const levelButton = (text: string) => {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`단추 없음: ${text}`);
    return btn;
  };

  const lv = { all: koMessages.settings.notificationLevel_all, mentions: koMessages.settings.notificationLevel_mentions, mute: koMessages.settings.notificationLevel_mute };

  it('고른 레벨만 aria-pressed=true · 누르면 옮겨 간다', async () => {
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    // 서버 기록 없음 → 기본 «전체».
    expect(levelButton(lv.all).getAttribute('aria-pressed')).toBe('true');
    expect(levelButton(lv.mentions).getAttribute('aria-pressed')).toBe('false');
    expect(levelButton(lv.mute).getAttribute('aria-pressed')).toBe('false');

    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ data: [{ scope_type: 'global', channel: 'in_app', level: 'mentions' }] }) }));
    await click(levelButton(lv.mentions));
    expect(levelButton(lv.mentions).getAttribute('aria-pressed')).toBe('true');
    expect(levelButton(lv.all).getAttribute('aria-pressed')).toBe('false');
  });
});
