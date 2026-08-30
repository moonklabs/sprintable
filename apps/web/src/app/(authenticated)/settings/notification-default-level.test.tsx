// @vitest-environment jsdom
//
// story #3222 — 기본 알림 레벨 저장이 화면에 반영 안 되던 결함(BE notification-preferences가
// {"data": [...]}로 이중래핑 반환 → FE 프록시가 그 위에 다시 감싸 {data: {data: [...]}}가
// 됨 → 화면 파서가 배열을 못 찾아 조용히 무반영)의 UI측 라이브 pin. route.test.ts(같은
// story)가 프록시 실경로의 단일래핑을 증명하고, 이 파일은 "그 정합된 응답이 왔을 때 화면이
// 실제로 즉시 반영하는지"를 증명한다.

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

// GET 계열은 fetchWithAuth 경유 — /api/current-project·/api/notification-preferences만
// 의미있는 값을 주고 나머지는 기존 page.test.tsx와 동형으로 ok:false 기본값.
let preferenceLevel: 'all' | 'mentions' | 'mute' = 'all';

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    if (url === '/api/current-project') {
      return { ok: true, json: async () => ({ data: { project_id: 'proj-1', org_id: 'org-1' } }) };
    }
    if (url === '/api/notification-preferences') {
      return {
        ok: true,
        json: async () => ({
          data: [{ scope_type: 'global', channel: 'in_app', level: preferenceLevel }],
        }),
      };
    }
    return { ok: false, json: async () => ({ data: null }) };
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <RefreshProvider>{node}</RefreshProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  preferenceLevel = 'all';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [] });
  // RefreshProvider가 마운트 시 localStorage.getItem을 읽는다 — jsdom 환경설정에
  // storage 백엔드가 없어 인메모리 스텁으로 대체(이 테스트의 관심사가 아님).
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  // PUT은 handleSetGlobalPreferenceLevel이 raw fetch로 직접 호출(fetchWithAuth 아님).
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [{ scope_type: 'global', channel: 'in_app', level: 'mentions' }] }),
  })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  // vi.resetModules()는 호출하지 않는다 — RefreshProvider를 이 파일 상단에서 정적
  // import하는데, resetModules 후 SettingsPage를 동적 재-import하면 RefreshContext
  // 모듈 인스턴스가 갈라져(Provider≠Consumer 심볼) "must be used within
  // RefreshProvider"가 오탐으로 뜬다.
});

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(wrap(node)); });
  // loadContext의 GET 체인(현재-프로젝트→org목록→notification-settings→notification-preferences
  // →webhooks)이 여러 await를 거치므로 microtask flush를 한 번 더 준다.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function levelButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn;
}

describe('SettingsPage — 기본 알림 레벨 즉시 반영(story #3222)', () => {
  it('GET(서버=mentions)이면 마운트 직후 화면도 «멘션만»이 선택 표시된다(리로드=재마운트와 동형)', async () => {
    preferenceLevel = 'mentions';
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    const mentionsBtn = levelButton('멘션만');
    // 선택된 버튼엔 bg-primary가 붙는다(원 컴포넌트 조건부 className).
    expect(mentionsBtn.className).toContain('bg-primary');
  });

  it('«멘션만» 클릭 → PUT 응답 반영해 화면이 즉시 «멘션만»으로 갱신된다(무반영 회귀가드)', async () => {
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    // 초기값은 all이 선택 표시.
    expect(levelButton('전체').className).toContain('bg-primary');

    await act(async () => {
      levelButton('멘션만').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(levelButton('멘션만').className).toContain('bg-primary');
    expect(levelButton('전체').className).not.toContain('bg-primary');
  });
});
