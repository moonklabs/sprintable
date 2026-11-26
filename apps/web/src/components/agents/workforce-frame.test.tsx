// @vitest-environment jsdom
//
// story 5035 (C5) — 에이전트 1뎁스: «목록 → 상세» 한 틀. 구조를 못 박는 시험(되돌리면 빨갛다):
//  · 주소가 판정한다 — /organization/workforce(관리) · /organization/workforce/{id} 는 «목록 + 상세» 틀, 실행 기록 · 키 · 통계 · 영입 · 접근표는 «전체 보기» 틀(목록 없음 + 위에 전체 보기 줄).
//  · 옛 «팀» 줄의 일곱 곳은 전부 닿는다(빠짐 0): 에이전트 · 사람(members에 그대로) · 실행 기록 · 키 · 영입 · 통계 · 접근표.
//  · 옛 주소는 하나도 안 사라진다(주소를 그대로 둔 채 틀만 바뀐다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TEAM_TABS } from '@/lib/nav-config';

let pathname = '/organization/workforce';
let search = '';
let wide = true;
let admin = true;
const push = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
vi.mock('@/hooks/use-org-admin', () => ({ useOrgAdmin: () => ({ isAdmin: admin, loaded: true }) }));
vi.mock('@/hooks/use-list-detail-wide', () => ({ useListDetailWide: () => wide }));
let onAdd: () => void = () => {};
vi.mock('@/components/agents/agent-management-tab', () => ({
  AgentManagementTab: ({ onAddAgent, compact }: { onAddAgent: () => void; compact?: boolean }) => { onAdd = onAddAgent; return <div data-testid="agent-list-stub" data-compact={String(!!compact)} />; },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  pathname = '/organization/workforce';
  search = '';
  wide = true;
  admin = true;
  push.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount() {
  const { WorkforceFrame } = await import('./workforce-frame');
  await act(async () => { root.render(<WorkforceFrame><div data-testid="child" /></WorkforceFrame>); });
}

describe('resolveWorkforceView — 주소가 틀을 정한다', () => {
  it('관리(기본) · 탭 이름 모르는 값 · 에이전트 상세는 «목록 + 상세»', async () => {
    const { resolveWorkforceView } = await import('./workforce-frame');
    expect(resolveWorkforceView('/organization/workforce', null)).toEqual({ kind: 'split', agentId: null });
    expect(resolveWorkforceView('/organization/workforce', 'manage')).toEqual({ kind: 'split', agentId: null });
    expect(resolveWorkforceView('/organization/workforce', 'bogus')).toEqual({ kind: 'split', agentId: null });
    expect(resolveWorkforceView('/organization/workforce/abc-123', null)).toEqual({ kind: 'split', agentId: 'abc-123' });
  });

  it('실행 기록 · 키 · 통계 · 영입 · 접근표는 «전체 보기» (옛 주소 그대로)', async () => {
    const { resolveWorkforceView } = await import('./workforce-frame');
    expect(resolveWorkforceView('/organization/workforce/runs', null)).toEqual({ kind: 'all', key: 'runs' });
    expect(resolveWorkforceView('/organization/workforce/api-keys', null)).toEqual({ kind: 'all', key: 'keys' });
    expect(resolveWorkforceView('/organization/workforce', 'stats')).toEqual({ kind: 'all', key: 'stats' });
    expect(resolveWorkforceView('/organization/workforce', 'recruit')).toEqual({ kind: 'all', key: 'recruit' });
    expect(resolveWorkforceView('/organization/workforce', 'access')).toEqual({ kind: 'all', key: 'access' });
  });

  it('⭐빠짐 0 — 옛 «팀» 줄 일곱 칸이 가던 곳은 «사람»만 빼고 전부 이 틀 안에서 닿는다', async () => {
    const { resolveWorkforceView, ALL_VIEWS } = await import('./workforce-frame');
    const wfTabs = TEAM_TABS.filter((tab) => tab.id !== 'people');
    expect(TEAM_TABS.map((tab) => tab.id)).toEqual(['agents', 'people', 'runs', 'keys', 'recruit', 'stats', 'access']);
    for (const tab of wfTabs) {
      const [path, query = ''] = tab.path.split('?');
      const view = resolveWorkforceView(path, new URLSearchParams(query).get('tab'));
      if (tab.id === 'agents') {
        expect(view.kind).toBe('split');
      } else {
        expect(view.kind).toBe('all');
        const key = (view as { key: string }).key;
        const entry = ALL_VIEWS.find((v) => v.key === key)!;
        expect(entry, `전체 보기에 ${tab.id}가 없다`).toBeTruthy();
        expect(entry.path).toBe(tab.path); // 옛 주소가 한 글자도 안 바뀐다
      }
    }
  });
});

describe('WorkforceFrame — 목록 → 상세', () => {
  it('넓은 화면, 에이전트 없는 주소: 목록 칸 + 상세 칸(비어 있는 안내가 children), 전체 보기 줄은 목록 머리의 «전체 보기» 한 곳', async () => {
    await mount();
    expect(container.querySelector('[data-testid="agent-list-stub"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workforce-detail-column"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workforce-detail-column"] [data-testid="child"]')).toBeTruthy();
    // 목록 칸 머리에 «전체 보기» 입구 하나(다섯 곳으로 가는 링크)
    const entry = container.querySelector('[data-testid="workforce-all-views-menu"]');
    expect(entry).toBeTruthy();
    expect(container.querySelector('[data-testid="workforce-all-views-strip"]')).toBeNull();
    // the strip is NAMED («전체 보기») — bare links with nothing lit read as the list's own tabs — and the list drops its page padding inside the column
    expect(entry!.querySelector('[data-testid="workforce-all-views-caption"]')?.textContent).toBe('allViewsCaption');
    expect(container.querySelector('[data-testid="agent-list-stub"]')?.getAttribute('data-compact')).toBe('true');
  });

  it('넓은 화면, 에이전트 상세 주소: 목록과 상세가 «같이» 보인다(목록 → 상세 칸 순서)', async () => {
    pathname = '/organization/workforce/abc-123';
    await mount();
    const root_ = container.querySelector('[data-testid="workforce-frame"]')!;
    const list = root_.querySelector('[data-testid="agent-list-stub"]')!;
    const detail = root_.querySelector('[data-testid="workforce-detail-column"] [data-testid="child"]')!;
    expect(list).toBeTruthy();
    expect(detail).toBeTruthy();
    expect(list.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('좁은 화면, 에이전트 없는 주소: 목록만(상세 칸 · 시트 없음)', async () => {
    wide = false;
    await mount();
    expect(container.querySelector('[data-testid="agent-list-stub"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="child"]')).toBeNull();
    expect(container.querySelector('[data-testid="workforce-detail-column"]')).toBeNull();
  });
});

describe('WorkforceFrame — 에이전트 추가', () => {
  it('⭐«에이전트 추가»는 진짜 이동이다 — 채용의 주소(?tab=recruit)로 push (목록과 함께 이 틀로 옮겨 왔다)', async () => {
    await mount();
    await act(async () => { onAdd(); });
    expect(push).toHaveBeenCalledWith('/organization/workforce?tab=recruit');
  });

  it('좁은 화면 + 에이전트 주소: 상세는 시트로 열린다(목록은 그대로 뒤에)', async () => {
    wide = false;
    pathname = '/organization/workforce/abc-123';
    await mount();
    expect(container.ownerDocument.querySelector('[data-testid="workforce-detail-sheet"]')).toBeTruthy();
  });
});

describe('WorkforceFrame — 전체 보기', () => {
  it('실행 기록 주소: 목록 칸 없음 · 위에 전체 보기 줄(켜진 칸 하나) + 에이전트 목록으로 돌아가는 길 · 본문은 그대로', async () => {
    pathname = '/organization/workforce/runs';
    await mount();
    expect(container.querySelector('[data-testid="agent-list-stub"]')).toBeNull();
    const strip = container.querySelector('[data-testid="workforce-all-views-strip"]')!;
    expect(strip).toBeTruthy();
    const links = [...strip.querySelectorAll('a[data-all-view]')].map((a) => a.getAttribute('data-all-view'));
    expect(links).toEqual(['runs', 'keys', 'stats', 'access', 'recruit']);
    const active = strip.querySelectorAll('a[aria-current="page"]');
    expect(active).toHaveLength(1);
    expect(active[0]!.getAttribute('data-all-view')).toBe('runs');
    expect(container.querySelector('[data-testid="workforce-back-to-list"]')?.getAttribute('href')).toBe('/organization/workforce');
    expect(container.querySelector('[data-testid="child"]')).toBeTruthy();
  });

  it('접근표는 관리자에게만 줄에 선다', async () => {
    admin = false;
    pathname = '/organization/workforce/api-keys';
    await mount();
    const links = [...container.querySelectorAll('[data-testid="workforce-all-views-strip"] a[data-all-view]')].map((a) => a.getAttribute('data-all-view'));
    expect(links).toEqual(['runs', 'keys', 'stats', 'recruit']);
  });

  it('?tab=stats 주소도 전체 보기(통계 칸이 켜짐)', async () => {
    search = 'tab=stats';
    await mount();
    expect(container.querySelector('[data-testid="agent-list-stub"]')).toBeNull();
    expect(container.querySelector('[data-testid="workforce-all-views-strip"] a[aria-current="page"]')?.getAttribute('data-all-view')).toBe('stats');
  });
});
