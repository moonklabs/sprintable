// @vitest-environment jsdom
//
// story #2413 — closed가 아닌 회고 phase가 오래 멈춰 있으면 화면이 말하는지(경고 배지) 왕복
// 검증한다. 실측(2026-08-02): "회고제목"(action, 2026-07-01부터 정지)이 실제 회고와 나란히
// 아무 표시 없이 서 있었다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import { isRetroStale, daysStale } from './retro-staleness';

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// story #2413 test note — RetroRouteProvider는 mount() 안에서 './page'와 «같은» 동적
// import 그래프로 가져와야 한다(afterEach의 vi.resetModules() 탓에 정적 import는 다른
// Context 인스턴스가 되어 "useRetroRoute must be used within RetroRouteProvider"로 깨진다).
function wrap(RetroRouteProvider: React.ComponentType<{ wsSlug: string; projSlug: string; projectId: string; children: React.ReactNode }>, node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <RetroRouteProvider wsSlug="ws" projSlug="proj" projectId="proj-1">
        {node}
      </RetroRouteProvider>
    </NextIntlClientProvider>
  );
}

function stubFetch(sessions: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/retro-sessions?project_id=')) {
      return { ok: true, json: async () => ({ data: sessions }) };
    }
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: false, json: async () => null };
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: RetroPage } = await import('./page');
  const { RetroRouteProvider } = await import('./retro-context');
  await act(async () => { root.render(wrap(RetroRouteProvider, <RetroPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('isRetroStale/daysStale — story #2413', () => {
  it('실측과 같은 모양 — action phase가 14일 이상 안 움직이면 stale', () => {
    const now = new Date('2026-08-02T00:00:00Z');
    expect(isRetroStale({ phase: 'action', updated_at: '2026-07-01T05:42:10Z' }, now)).toBe(true);
    expect(daysStale('2026-07-01T05:42:10Z', now)).toBe(31);
  });

  it('vote phase도 같은 기준으로 stale 판정된다', () => {
    const now = new Date('2026-08-02T00:00:00Z');
    expect(isRetroStale({ phase: 'vote', updated_at: '2026-07-01T05:48:06Z' }, now)).toBe(true);
  });

  it('closed면 아무리 오래 전이어도 stale 아님', () => {
    const now = new Date('2026-08-02T00:00:00Z');
    expect(isRetroStale({ phase: 'closed', updated_at: '2020-01-01T00:00:00Z' }, now)).toBe(false);
  });

  it('음성대조 — 임계(14일) 미만이면 stale 아니다', () => {
    const now = new Date('2026-08-02T00:00:00Z');
    expect(isRetroStale({ phase: 'action', updated_at: '2026-07-25T00:00:00Z' }, now)).toBe(false);
  });

  // 카디르 QA(2026-08-02) — 뮤테이션(>=14 → >14, 하루 어긋난 회귀)이 7/7 GREEN인 채로 통과했다.
  // 기존 테스트가 31일(참)·8일(거짓)만 재서 경계(13/14/15)를 아무도 안 쟀기 때문 — 코드 자체는
  // 정확했지만(13→false·14→true·15→true, 카디르 직접 계산) 그 정확함을 지켜 줄 테스트가
  // 없었다. "지금 맞다"와 "앞으로도 맞을 것이다"는 다른 축이라 경계값을 직접 고정한다.
  it('경계 — 정확히 13일이면 stale 아니다(임계 미만)', () => {
    const now = new Date('2026-08-02T00:00:00Z');
    expect(daysStale('2026-07-20T00:00:00Z', now)).toBe(13);
    expect(isRetroStale({ phase: 'action', updated_at: '2026-07-20T00:00:00Z' }, now)).toBe(false);
  });

  it('경계 — 정확히 14일이면 stale이다(임계 그 자체)', () => {
    const now = new Date('2026-08-02T00:00:00Z');
    expect(daysStale('2026-07-19T00:00:00Z', now)).toBe(14);
    expect(isRetroStale({ phase: 'action', updated_at: '2026-07-19T00:00:00Z' }, now)).toBe(true);
  });

  it('경계 — 정확히 15일이면 stale이다(임계 초과)', () => {
    const now = new Date('2026-08-02T00:00:00Z');
    expect(daysStale('2026-07-18T00:00:00Z', now)).toBe(15);
    expect(isRetroStale({ phase: 'action', updated_at: '2026-07-18T00:00:00Z' }, now)).toBe(true);
  });
});

describe('RetroPage — 오래 멈춘 phase 배지 렌더(story #2413)', () => {
  it('action phase + 과거 updated_at(2020, 항상 stale) 회고는 목록에 경고 배지를 보인다', async () => {
    stubFetch([{ id: 'r1', title: '회고제목', phase: 'action', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-02T00:00:00Z' }]);
    await mount();
    expect(container.innerHTML).toContain('같은 단계');
  });

  // 유나 규격(2026-08-02, #2791 design:changes) — warning tint 위 text-warning은 light에서
  // 2.06(AA 미달)이라 이 배지만 text-foreground로 덮는다. 회귀 가드.
  it('경고 배지는 text-foreground로 오버라이드돼 있다(유나 규격) — text-warning 단독이 아니다', async () => {
    stubFetch([{ id: 'r1', title: '회고제목', phase: 'action', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-02T00:00:00Z' }]);
    await mount();
    const badge = [...container.querySelectorAll('span')].find((el) => el.textContent?.includes('같은 단계'));
    expect(badge).not.toBeUndefined();
    expect(badge!.className).toContain('text-foreground');
  });

  it('음성대조 — 방금 갱신된 회고는 경고 배지가 없다', async () => {
    const justNow = new Date().toISOString();
    stubFetch([{ id: 'r1', title: '진행중 회고', phase: 'vote', created_at: justNow, updated_at: justNow }]);
    await mount();
    expect(container.innerHTML).not.toContain('같은 단계');
  });

  it('음성대조 — closed 회고는 updated_at이 과거여도 경고 배지가 없다', async () => {
    stubFetch([{ id: 'r1', title: '끝난 회고', phase: 'closed', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-02T00:00:00Z' }]);
    await mount();
    expect(container.innerHTML).not.toContain('같은 단계');
  });
});
