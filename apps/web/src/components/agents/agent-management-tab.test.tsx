// @vitest-environment jsdom
//
// story #3519(§16-7 2부, PO 確定 2026-09-05) — meRes/projectsRes 둘 다 부수(ok?채움:방치,
// meRes는 isAdmin 판정만)인데 격리 없이 같은 try 안에 있어, meRes가 네트워크단 reject하면
// 바깥 catch가 setLoadError(true)로 승격시켜 에이전트 목록(이 탭의 실제 주 콘텐츠)까지
// 통째로 못 뜨던 결함의 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentManagementTab } from './agent-management-tab';

// story 4912 — the rows open the detail through the router (Enter / double click): a stub router, the push is not under test here
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
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

function stubFetch(opts: { meReject?: boolean; agents?: { id: string; name: string; role: string; is_active: boolean; verified?: boolean | null; runtime_type?: string | null }[] } = {}) {
  const agents = opts.agents ?? [{ id: 'a1', name: '에이전트 하나', role: 'member', is_active: true }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/me') {
      if (opts.meReject) throw new Error('network down');
      return { ok: true, json: async () => ({ data: { role: 'admin' } }) };
    }
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/team-members?')) {
      return { ok: true, json: async () => ({ data: agents }) };
    }
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<AgentManagementTab />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

// story 4912 — the row's actions live in the «⋯» / right-click menu (one array): open a row's menu and read its items
const rowEl = (id: string) => container.querySelector(`[data-testid="agent-row-${id}"]`)!;
const openMenu = async (id: string) => {
  const more = rowEl(id).querySelector('[data-slot="ds-row-actions-trigger"]') as HTMLElement | null;
  if (more) await act(async () => { more.click(); });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
};
const closeMenu = async () => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); };
const chips = () => [...container.querySelectorAll('[data-slot="ds-chip"]')].map((el) => el.textContent?.trim());
const subtitleOf = (id: string) => rowEl(id).querySelector('[data-slot="ds-list-row"] .font-mono')?.textContent ?? '';

// story #3994(«거짓 경고» 클래스, PO 확定) — 「시스템 발행」(runtime_type==='system-
// publisher')은 verified가 항상 false지만 연결 대상이 아니다. 행은 남기되(선생님
// 3107) 경고 배지·연결 설정 CTA는 뗀다. 일반 verified=false 에이전트는 회귀 0으로
// 기존 경고를 그대로 유지해야 한다.
describe('AgentManagementTab — 시스템 발행 거짓 경고 중립화(story #3994)', () => {
  it('⭐일반 에이전트 verified=false면 「연결 안 됨」 배지+「연결 설정 보기」 CTA가 그대로 뜬다(회귀 0)', async () => {
    stubFetch({ agents: [{ id: 'a1', name: '일반 에이전트', role: 'member', is_active: true, verified: false, runtime_type: 'claude-code' }] });
    await mount();
    expect(chips()).toContain('연결 안 됨');
    // story 4912 — «연결 설정 보기» is now an item of the row menu (the duplicate link and the arrow are gone)
    const items = await openMenu('a1');
    expect(items.map((i) => i.textContent)).toContain('연결 설정 보기');
    await closeMenu();
  });

  it('⭐「시스템 발행」(runtime_type=system-publisher, verified=false)은 행은 뜨되 경고·CTA 0, 중립 설명 1줄', async () => {
    stubFetch({ agents: [{ id: 'sp1', name: '시스템 발행', role: 'member', is_active: true, verified: false, runtime_type: 'system-publisher' }] });
    await mount();
    expect(container.textContent).toContain('시스템 발행');
    expect(container.textContent).not.toContain('연결 안 됨');
    expect((await openMenu('sp1')).map((i) => i.textContent)).not.toContain('연결 설정 보기');
    await closeMenu();
    expect(container.textContent).toContain('Sprintable이 자동으로 남기는 알림·기록의 보낸 이예요');
  });
});

// [SID:4282 · 유나 결정] 배포 27 기기 탐색 점검 7번 — 역할 칩에 조직 역할 원문(«member»)이 샜고(직무 해석기에 넣어서),
// «inactive»가 글자 그대로 이름 줄에 붙어 이름을 5자로 밀었다. 조직 역할 라벨(소유자 · 관리자 · 구성원 · 모르는 값만 원문) ·
// 비활성은 칩 줄로(secondary) · 이름 줄엔 이름만.
describe('AgentManagementTab — 역할 · 비활성 칩(SID:4282)', () => {
  // story 4912 — the org role is part of the row's second line now (a chip used to say it): the texts of the second lines
  const badgeTexts = () => [...container.querySelectorAll('[role="listitem"][data-testid^="agent-row-"]')].flatMap((r) => (r.querySelector('[data-slot="ds-list-row"] .font-mono')?.textContent ?? '').split(' · '));
  it('member → «구성원» · admin → «관리자» · owner → «소유자», 원문 0', async () => {
    stubFetch({ agents: [
      { id: 'a1', name: '멤버 에이전트', role: 'member', is_active: true },
      { id: 'a2', name: '관리 에이전트', role: 'admin', is_active: true },
      { id: 'a3', name: '소유 에이전트', role: 'owner', is_active: true },
    ] });
    await mount();
    const chips = badgeTexts();
    expect(chips).toContain(koMessages.organization.roleGroupMember);
    expect(chips).toContain(koMessages.organization.roleGroupAdmin);
    expect(chips).toContain(koMessages.organization.roleGroupOwner);
    for (const raw of ['member', 'admin', 'owner']) expect(chips).not.toContain(raw);
  });
  it('⭐story #4311(유나 비차단) — 같은 이름 에이전트: 역할 배지가 서로 다르면 꼬리 없음 · 같으면 «· ID 앞 8자»', async () => {
    stubFetch({ agents: [
      { id: 'aaaaaaaa-1', name: '점검봇', role: 'member', is_active: true },
      { id: 'bbbbbbbb-2', name: '점검봇', role: 'admin', is_active: true },
    ] });
    await mount();
    const texts = [...container.querySelectorAll('a [data-row-name]')].map((e) => e.textContent ?? '');
    expect(texts.filter((x) => x === '점검봇')).toHaveLength(2);
    expect(texts.some((x) => x.includes('aaaaaaaa'))).toBe(false);
  });

  it('story #4311 — 같은 이름 · 같은 역할이면 ID 꼬리로 갈린다', async () => {
    stubFetch({ agents: [
      { id: 'aaaaaaaa-1', name: '점검봇', role: 'member', is_active: true },
      { id: 'bbbbbbbb-2', name: '점검봇', role: 'member', is_active: true },
    ] });
    await mount();
    const texts = [...container.querySelectorAll('a [data-row-name]')].map((e) => e.textContent ?? '');
    expect(texts).toContain('점검봇 · aaaaaaaa');
    expect(texts).toContain('점검봇 · bbbbbbbb');
  });

  it('모르는 값만 원문으로(유나 결정) — 프로토타입 이름도 원문 문자열이지 함수가 아니다', async () => {
    stubFetch({ agents: [
      { id: 'a1', name: '프로토 에이전트', role: 'constructor', is_active: true },
      { id: 'a2', name: '다른 에이전트', role: 'viewer', is_active: true },
    ] });
    await mount();
    const chips = badgeTexts();
    expect(chips).toContain('constructor');
    expect(chips).toContain('viewer');
    expect(container.textContent ?? '').not.toContain('function');
  });
  it('비활성: «비활성» 칩이 오른쪽 상태 자리에 중립 칩으로 · 이름 줄엔 이름만 · 원문 «inactive» 0', async () => {
    stubFetch({ agents: [{ id: 'a1', name: 'Backend-agent-with-a-long-name', role: 'member', is_active: false }] });
    await mount();
    const inactive = [...container.querySelectorAll('[data-slot="ds-chip"]')].find((el) => el.textContent?.trim() === koMessages.settings.agentInactiveBadge);
    expect(inactive).toBeTruthy();
    expect(inactive?.getAttribute('data-tone')).toBe('neutral'); // a state that can be undone: not red
    const nameLine = container.querySelector('a .truncate')?.parentElement;
    expect(nameLine?.textContent?.trim()).toBe('Backend-agent-with-a-long-name');
    expect(container.textContent ?? '').not.toContain('inactive');
  });
});

describe('AgentManagementTab — meRes/projectsRes 격리(story #3519)', () => {
  it('/api/me가 네트워크 reject해도 에이전트 목록(주 콘텐츠)은 그대로 뜬다(loadError로 승격 안 됨)', async () => {
    stubFetch({ meReject: true });
    await mount();
    expect(container.textContent).toContain('에이전트 하나');
  });
});

// story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「비활성화」 접근 이름이라 보조기술
// 버튼 목록에서 어느 에이전트 행인지 못 가른다.
describe('AgentManagementTab — 토글 행동의 접근 이름 전수(story #3592)', () => {
  it('⭐#3592 — 2건이면 두 행의 «⋯» 단추 접근 이름이 서로 다르고 각자 그 행의 이름을 품는다 · 메뉴 항목은 «비활성화»', async () => {
    stubFetch({
      agents: [
        { id: 'a1', name: '에이전트 하나', role: 'member', is_active: true },
        { id: 'a2', name: '에이전트 둘', role: 'member', is_active: true },
      ],
    });
    await mount();

    const triggers = [...container.querySelectorAll('[data-slot="ds-row-actions-trigger"]')];
    expect(triggers).toHaveLength(2);
    const names = triggers.map((b) => b.getAttribute('aria-label'));
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toContain('에이전트 하나');
    expect(names[1]).toContain('에이전트 둘');
    expect((await openMenu('a1')).map((i) => i.textContent)).toContain('비활성화');
    await closeMenu();
  });
});

// story #3608(유나 §22-18 ④-2, PO 確定 2026-09-07) — pending 中 "..."는 위 aria-label
// 안에도 그대로 들어갔다(발견 시점 실측). 활성화는 확認 다이얼로그 없이 즉시 실행되므로
// (requestToggle의 확認-우회 분기, story #2406 AC1) 그 경로로 pending 상태를 잡는다.
describe('AgentManagementTab — pending 라벨 낱말화(story #3608)', () => {
  it('⭐#3608 — 활성화 pending 中 접근 이름·보이는 글자에 "..." 0, "변경 중" 포함', async () => {
    let resolvePatch!: () => void;
    const patchPending = new Promise<void>((resolve) => { resolvePatch = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url !== 'string') return { ok: false, json: async () => null };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { role: 'admin' } }) };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
      if (url.startsWith('/api/team-members?')) {
        return { ok: true, json: async () => ({ data: [{ id: 'a1', name: '에이전트 하나', role: 'member', is_active: false }] }) };
      }
      if (url === '/api/team-members/a1' && init?.method === 'PATCH') {
        await patchPending;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, json: async () => null };
    }));
    await mount();

    // story 4912 — the toggle is a row menu item now: activate it (no confirm — the undoable direction), then look at the same item while the PATCH is out
    const activate = (await openMenu('a1')).find((i) => i.textContent === '활성화');
    expect(activate).not.toBeUndefined();
    await act(async () => {
      activate!.click();
      await Promise.resolve();
    });
    const pending = (await openMenu('a1'))[0]!;
    expect(pending.textContent).not.toContain('...');
    expect(pending.textContent).toContain('변경 중');
    expect(pending.hasAttribute('data-disabled') || pending.getAttribute('aria-disabled') === 'true').toBe(true); // the same action cannot be pressed twice
    await closeMenu();
    resolvePatch();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  });
});
