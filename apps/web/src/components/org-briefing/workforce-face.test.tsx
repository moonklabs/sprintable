// @vitest-environment jsdom
//
// story 09fa254e — WorkforceFace 왕복 검증: 3 BFF(dashboard/overview·stories·team-members) 조합이
// 실제로 협업 클러스터+claimed/verified 씰로 렌더되는지, 그리고 감시 최고위험 면답게 개수/처리량/
// 시간 낙인 문구가 전혀 새지 않는지(collaboration-map.test.tsx와 동형 회귀가드) 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { WorkforceFace } from './workforce-face';
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

function stubFetch(overview: unknown, storiesByEpic: Record<string, unknown>, members: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/dashboard/overview')) return { ok: true, json: async () => overview };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => members };
    if (url.includes('/api/stories')) {
      const epicId = new URL(url, 'http://localhost').searchParams.get('epic_id')!;
      return { ok: true, json: async () => storiesByEpic[epicId] ?? { data: [] } };
    }
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<WorkforceFace projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const OVERVIEW = { data: { project_status: { epics: [{ epic_id: 'e1', title: 'E-CANVAS', status: 'active' }] } } };
const MEMBERS = { data: [{ id: 'm1', name: 'Yuna' }, { id: 'm2', name: 'Miruko' }] };

describe('WorkforceFace', () => {
  it('renders collaborators (presence only) and a verified seal when any story is human_verified', async () => {
    stubFetch(OVERVIEW, {
      e1: { data: [{ assignee_ids: ['m1', 'm2'], self_reported: true, human_verified: true }] },
    }, MEMBERS);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('E-CANVAS');
    expect(html).toContain('사람이 확인함');
    expect(html).toContain('함께 일하는 중');
  });

  it('renders a claimed seal (not verified) when self-reported but not yet human-verified', async () => {
    stubFetch(OVERVIEW, { e1: { data: [{ assignee_ids: ['m1'], self_reported: true, human_verified: false }] } }, MEMBERS);
    await mount();
    expect(container.innerHTML).toContain('에이전트 완료 · 검토 대기');
    expect(container.innerHTML).not.toContain('사람이 확인함');
  });

  it('renders the neutral "아직 배정 전입니다" row instead of hiding the epic when it has no assignees', async () => {
    stubFetch(OVERVIEW, { e1: { data: [] } }, MEMBERS);
    await mount();
    expect(container.innerHTML).toContain('E-CANVAS');
    expect(container.innerHTML).toContain('아직 배정 전입니다');
  });

  it('story 64b9a879 — 활성 에픽 자체가 없으면 인간+AI 하이브리드 정체성 빈상태(Users+Bot 아이콘·발견성 카피)를 렌더한다', async () => {
    stubFetch({ data: { project_status: { epics: [] } } }, {}, MEMBERS);
    await mount();
    expect(container.innerHTML).toContain('사람과 AI가 함께 맡은 일이 여기 모입니다');
    // lucide 아이콘은 svg로 렌더 — Users+Bot 2개가 정확히 뜨는지(가벼운 아이콘 2개, 무거운 일러스트 아님).
    expect(container.querySelectorAll('svg').length).toBe(2);
  });

  it('never renders a per-person count, ranking, or elapsed-time string alongside the actual rendered row (collaboration-map.test.tsx parity — highest surveillance-risk surface)', async () => {
    // 까심 REQUEST_CHANGES(#2161) — S2(425085b4)와 동일 공허-통과 클래스: negative 정규식만 걸면
    // 컴포넌트가 통째로 빈 화면을 뱉어도 항상 통과한다. 같은 mount·같은 DOM에서 실제 아바타/씰이
    // 렌더됐다는 positive 어서션을 먼저 확認한 뒤에만 negative를 의미 있게 걸 수 있다.
    stubFetch(OVERVIEW, {
      e1: { data: [{ assignee_ids: ['m1', 'm2'], self_reported: true, human_verified: true }] },
    }, MEMBERS);
    await mount();
    const html = container.innerHTML;

    // positive — 협업 아바타(참여자 이니셜 툴팁)와 신뢰 씰이 실제로 이 DOM에 렌더됐다.
    expect(html).toContain('title="Yuna"');
    expect(html).toContain('title="Miruko"');
    expect(html).toContain('함께 일하는 중');
    expect(html).toContain('사람이 확인함');

    // negative — 위 실렌더 상태에서도 개수/순위/경과시간 낙인 문구는 전혀 없다.
    expect(html).not.toMatch(/\d+\s*명/);
    expect(html).not.toMatch(/\d+\s*개\s*완료/);
    expect(html).not.toMatch(/\d+\s*(분|시간|일)(?!건)/);
    expect(html).not.toMatch(/순위|랭킹|처리량/);
  });
});
