// @vitest-environment jsdom
//
// story #4888 (UI-5 AC4, home) — the honesty rules of the home model (each one fails when it is undone): the newest load wins · what is project-scoped does not follow a person to another
// project · a failed side read never turns into «all caught up» · a failed read keeps the last model and says so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

const need = (id: string, at: string) => ({
  kind: 'approval', risk: 'low', source: 'gate', source_id: id,
  work_item: { type: 'story', id: `s-${id}`, title: `결재 ${id}` },
  requested_by: null, reason: null, created_at: at, actions: ['approve'],
});
const todayOf = (needsMe: unknown[]) => ({ needs_me: needsMe, needs_me_count: needsMe.length, agent_progress: [], completed_today: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } } });
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
const bad = () => ({ ok: false, status: 500, json: async () => ({}) });
const agentStory = (id: string, title: string) => ({ id, title, status: 'in-progress', assignee_id: 'ag1', updated_at: '2026-09-13T05:00:00Z' });
const MEMBERS = [{ id: 'ag1', name: '개발 에이전트', type: 'agent' }];

async function mount(projectId: string | undefined, viewer: string | null = null, orgId?: string) {
  const { HomeModelProvider, useHomeModel } = await import('./home-model-provider');
  const { HomeList } = await import('./home-list');
  function Probe() {
    const { model, sources, partial, loadError, retry } = useHomeModel();
    return (
      <div>
        <span data-testid="badge">{model ? String(model.badge) : 'none'}</span>
        <span data-testid="working">{model ? model.working.map((r) => r.key).join(',') : 'none'}</span>
        <span data-testid="flags">{`${partial ? 'partial' : 'full'}|${loadError ? 'error' : 'ok'}`}</span>
        <button type="button" data-testid="retry" onClick={retry}>retry</button>
        {model && sources ? <HomeList model={model} sources={sources} partial={partial || loadError} /> : null}
      </div>
    );
  }
  const tree = (p: string | undefined, o: string | undefined = orgId) => (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <HomeModelProvider viewerMemberId={viewer} projectId={p} orgId={o}><Probe /></HomeModelProvider>
    </NextIntlClientProvider>
  );
  await act(async () => { root.render(tree(projectId)); });
  await settle();
  return {
    rerender: async (p: string | undefined) => { await act(async () => { root.render(tree(p)); }); },
    rerenderOrg: async (o: string | undefined) => { await act(async () => { root.render(tree(projectId, o)); }); },
  };
}
async function settle() { await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }); }
const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe('홈 모델 — 정직 규칙 (story #4888)', () => {
  it('⭐프로젝트를 옮기면 옛 프로젝트의 «일하는 중» 일감은 새 프로젝트에 안 따라온다 — 사람의 결재 · 알림은 그대로 남는다', async () => {
    let storiesFor: Record<string, unknown[]> = { p1: [agentStory('sa', 'A의 일감')], p2: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([need('g1', '2026-09-13T05:00:00Z')]));
      if (url.startsWith('/api/notifications')) return ok([]);
      if (url.startsWith('/api/stories')) return ok(storiesFor[new URL(url, 'http://x').searchParams.get('project_id')!]);
      if (url.startsWith('/api/members')) return ok(MEMBERS);
      return ok(null);
    }));
    const m = await mount('p1');
    expect(text('working')).toBe('story:sa');
    // p2's answer is held: until it comes, p1's story must not be shown as p2's
    let release!: () => void;
    storiesFor = { p1: [], p2: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/stories')) { await new Promise<void>((r) => { release = r; }); return ok([agentStory('sb', 'B의 일감')]); }
      if (url === '/api/today') return ok(todayOf([need('g1', '2026-09-13T05:00:00Z')]));
      if (url.startsWith('/api/notifications')) return ok([]);
      if (url.startsWith('/api/members')) return ok(MEMBERS);
      return ok(null);
    }));
    await m.rerender('p2');
    await settle();
    expect(text('working')).toBe(''); // A's story is gone; B's is not here yet
    expect(text('badge')).toBe('1'); // the approval is the person's, not the project's: it stays
    expect(text('flags')).toBe('partial|ok'); // and the model says it is not complete yet
    await act(async () => { release(); });
    await settle();
    expect(text('working')).toBe('story:sb');
    expect(text('flags')).toBe('full|ok');
  });

  it('⭐알림 읽기가 실패하면 «모두 확인했어요»로 위장하지 않는다 — 읽은 만큼의 수는 보이되 «부분»이라고 말한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([]));
      if (url.startsWith('/api/notifications')) return bad();
      return ok(null);
    }));
    await mount(undefined);
    expect(text('flags')).toBe('partial|ok');
    expect(container.querySelector('[data-testid="home-partial-empty"]')).not.toBeNull();
    expect(container.textContent).not.toContain('모두 확인했어요');
  });

  it('스토리 · 구성원 읽기가 실패해도 마찬가지다(프로젝트가 있을 때)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([]));
      if (url.startsWith('/api/notifications')) return ok([]);
      if (url.startsWith('/api/stories')) return bad();
      if (url.startsWith('/api/members')) return ok(MEMBERS);
      return ok(null);
    }));
    await mount('p1');
    expect(text('flags')).toBe('partial|ok');
    expect(container.textContent).not.toContain('모두 확인했어요');
  });

  it('⭐겹친 읽기에서 늦게 온 옛 답은 새 답을 덮지 못한다(가장 새로 시작한 읽기만 반영)', async () => {
    const releases: Array<() => void> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') {
        const mine = call++;
        if (mine === 0) { await new Promise<void>((r) => { releases.push(r); }); return ok(todayOf([need('old', '2026-09-13T05:00:00Z')])); }
        return ok(todayOf([need('new1', '2026-09-13T05:00:00Z'), need('new2', '2026-09-13T06:00:00Z')]));
      }
      if (url.startsWith('/api/notifications')) return ok([]);
      return ok(null);
    }));
    await mount(undefined); // read #1 is held
    expect(text('badge')).toBe('none');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); // read #2 starts and finishes
    await settle();
    expect(text('badge')).toBe('2');
    await act(async () => { releases[0]!(); }); // the OLD answer arrives late
    await settle();
    expect(text('badge')).toBe('2'); // still the newest one
  });

  it('읽기가 한 번 성공한 뒤 실패하면 마지막 모델을 지우지 않고 «불러오지 못했어요»를 말한다 — 다시 읽으면 풀린다', async () => {
    let failing = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return failing ? bad() : ok(todayOf([need('g1', '2026-09-13T05:00:00Z')]));
      if (url.startsWith('/api/notifications')) return ok([]);
      return ok(null);
    }));
    await mount(undefined);
    expect(text('flags')).toBe('full|ok');
    failing = true;
    await act(async () => { (container.querySelector('[data-testid="retry"]') as HTMLButtonElement).click(); });
    await settle();
    expect(text('badge')).toBe('1'); // the last model stays
    expect(text('flags')).toBe('full|error');
    failing = false;
    await act(async () => { (container.querySelector('[data-testid="retry"]') as HTMLButtonElement).click(); });
    await settle();
    expect(text('flags')).toBe('full|ok');
  });

  it('⭐조직을 바꾸면 옛 조직의 결재 · 알림 · 결과는 새 조직의 답이 올 때까지 보이지 않는다(두 조직 다 프로젝트가 없어도)', async () => {
    let release!: () => void;
    let phase: 'org-a' | 'org-b' = 'org-a';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') {
        if (phase === 'org-b') { await new Promise<void>((r) => { release = r; }); return ok(todayOf([])); }
        return ok(todayOf([need('a1', '2026-09-13T05:00:00Z'), need('a2', '2026-09-13T06:00:00Z')]));
      }
      if (url.startsWith('/api/notifications')) return ok([]);
      return ok(null);
    }));
    const m = await mount(undefined, null, 'org-a');
    expect(text('badge')).toBe('2');
    phase = 'org-b';
    await m.rerenderOrg('org-b');
    await settle();
    expect(text('badge')).toBe('none'); // org A's two approvals are not org B's
    await act(async () => { release(); });
    await settle();
    expect(text('badge')).toBe('0');
  });

  const mention = (id: string) => ({ id, type: 'conversation.mention', title: `멘션 ${id}`, is_read: false, reference_type: null, reference_id: null, created_at: '2026-09-13T05:00:00Z', href: null });
  const chatMessage = (id: string) => ({ id, type: 'conversation.message', title: `대화 ${id}`, is_read: false, reference_type: null, reference_id: null, created_at: '2026-09-13T05:00:00Z', href: null });
  const notifPages = (pages: unknown[][]) => vi.fn(async (url: string) => {
    if (url === '/api/today') return ok(todayOf([]));
    if (url.startsWith('/api/notifications')) {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      const i = cursor ? Number(cursor) : 0;
      return { ok: true, status: 200, json: async () => ({ data: pages[i] ?? [], meta: { hasMore: i < pages.length - 1, nextCursor: i < pages.length - 1 ? String(i + 1) : null } }) };
    }
    return ok(null);
  });

  it('⭐안 읽은 알림은 첫 50건에서 끊지 않고 쪽을 넘겨 읽는다 — 둘째 쪽에 있는 멘션도 수에 든다', async () => {
    vi.stubGlobal('fetch', notifPages([[chatMessage('m1'), chatMessage('m2')], [mention('n1')]]));
    await mount(undefined);
    expect(text('badge')).toBe('1');
    expect(text('flags')).toBe('full|ok');
  });

  it('⭐쪽 상한(5쪽)까지 읽고도 더 있으면 «부분»이라고 말한다 — 조용히 자르지 않는다', async () => {
    vi.stubGlobal('fetch', notifPages(Array.from({ length: 8 }, (_, i) => [chatMessage(`m${i}`)])));
    await mount(undefined);
    const calls = (fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.filter((c) => c[0].startsWith('/api/notifications'));
    expect(calls).toHaveLength(5);
    expect(text('flags')).toBe('partial|ok');
  });

  it('둘째 쪽 읽기가 실패해도 첫 쪽에서 읽은 것은 남고 «부분»이다', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([]));
      if (url.startsWith('/api/notifications')) {
        if (n++ === 0) return { ok: true, status: 200, json: async () => ({ data: [mention('n1')], meta: { hasMore: true, nextCursor: '1' } }) };
        return bad();
      }
      return ok(null);
    }));
    await mount(undefined);
    expect(text('badge')).toBe('1');
    expect(text('flags')).toBe('partial|ok');
  });

  it('스토리가 한 쪽(100)보다 많다고 서버가 말하면 «부분»이다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([]));
      if (url.startsWith('/api/notifications')) return ok([]);
      if (url.startsWith('/api/stories')) return { ok: true, status: 200, json: async () => ({ data: [agentStory('sa', 'A')], meta: { hasMore: true, nextCursor: 'x' } }) };
      if (url.startsWith('/api/members')) return ok(MEMBERS);
      return ok(null);
    }));
    await mount('p1');
    expect(text('flags')).toBe('partial|ok');
  });

  it('읽기 실패는 그 조직 · 구성원의 것이다 — 조직을 바꾸면 새 조직은 «불러오지 못했어요»가 아니라 읽는 중에서 시작한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/today' ? bad() : ok([]))));
    const m = await mount(undefined, null, 'org-a');
    expect(text('flags')).toBe('full|error');
    let release!: () => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') { await new Promise<void>((r) => { release = r; }); return ok(todayOf([])); }
      return ok([]);
    }));
    await m.rerenderOrg('org-b');
    await settle();
    expect(text('flags')).toBe('full|ok'); // no error carried over from org A, no model yet
    expect(text('badge')).toBe('none');
    await act(async () => { release(); });
    await settle();
    expect(text('badge')).toBe('0');
  });

  it('⭐페이지 정보가 없는 답: 50건 꽉 찬 쪽은 «끝»이라 말할 수 없다(부분), 짧은 쪽은 끝이다', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => chatMessage(`m${i}`));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/today' ? ok(todayOf([])) : url.startsWith('/api/notifications') ? ok(page(50)) : ok(null))));
    await mount(undefined);
    expect(text('flags')).toBe('partial|ok');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/today' ? ok(todayOf([])) : url.startsWith('/api/notifications') ? ok(page(3)) : ok(null))));
    await mount(undefined);
    expect(text('flags')).toBe('full|ok');
  });

  it('«더 있다»는데 이어 물을 커서가 없으면 끝이 아니다(부분) — 스토리의 모양 없는 페이지 정보도 마찬가지', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([]));
      if (url.startsWith('/api/notifications')) return { ok: true, status: 200, json: async () => ({ data: [chatMessage('m1')], meta: { hasMore: true, nextCursor: null } }) };
      return ok(null);
    }));
    await mount(undefined);
    expect(text('flags')).toBe('partial|ok');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([]));
      if (url.startsWith('/api/notifications')) return ok([]);
      if (url.startsWith('/api/stories')) return { ok: true, status: 200, json: async () => ({ data: [agentStory('sa', 'A')], meta: { something: 'else' } }) };
      if (url.startsWith('/api/members')) return ok(MEMBERS);
      return ok(null);
    }));
    await mount('p1');
    expect(text('flags')).toBe('partial|ok');
  });

  it('⭐60초 틱은 이미 도는 읽기 옆에 둘째 읽기를 시작하지 않는다 — 탭이 돌아오는 읽기는 시작한다(가장 새것이 이긴다)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let todayCalls = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/api/today') { todayCalls += 1; await new Promise<void>(() => {}); }
        return ok([]);
      }));
      const { HOME_POLL_MS } = await import('./home-model-provider');
      await mount(undefined);
      expect(todayCalls).toBe(1); // the first read, held for good
      await act(async () => { vi.advanceTimersByTime(HOME_POLL_MS * 3); });
      expect(todayCalls).toBe(1); // three ticks later: still one
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(todayCalls).toBe(2); // the tab coming back starts a new one
    } finally { vi.useRealTimers(); }
  });

  it('⭐완전했던 읽기가 둘째 쪽 실패로 쪼그라들지 않는다 — 막대 수는 그대로, 화면은 «불러오지 못했어요»를 말한다', async () => {
    let failSecondPage = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok(todayOf([need('g1', '2026-09-13T05:00:00Z')]));
      if (url.startsWith('/api/notifications')) {
        const cursor = new URL(url, 'http://x').searchParams.get('cursor');
        if (!cursor) return { ok: true, status: 200, json: async () => ({ data: [mention('n1')], meta: { hasMore: failSecondPage, nextCursor: failSecondPage ? '1' : null } }) };
        return bad();
      }
      return ok(null);
    }));
    await mount(undefined);
    expect(text('badge')).toBe('2'); // the approval + the mention
    expect(text('flags')).toBe('full|ok');
    failSecondPage = true;
    await act(async () => { (container.querySelector('[data-testid="retry"]') as HTMLButtonElement).click(); });
    await settle();
    expect(text('badge')).toBe('2'); // not 2 → fewer → 2 again
    expect(text('flags')).toBe('full|error');
  });
});

