// @vitest-environment jsdom
//
// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 본문에 별도 마스트헤드가 없어(3946 AC1 실측) TopBarSlot의 h1이 그대로 유일한 h1이다.
// 이 컴포넌트엔 아직 전용 렌더 테스트가 없어 h1 불변식 확인 목적으로 새로 둔다
// (activity-log-view.test.tsx와 동형 관례).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TeamActivityView } from './team-activity-view';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';

const fetchWithAuthMock = vi.fn();

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

// [SID:4300] 기본은 org 없음(조직 범위 보충 안 함 — 기존 테스트 그대로). 보충 테스트만 orgId를 채운다.
const dashCtx = vi.hoisted(() => ({ value: {} as { orgId?: string } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dashCtx.value }));
import { ORG_NAMES_URL, resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';

let container: HTMLDivElement;
let root: Root;

function TopBarTitleProbe() {
  const { title } = useTopBar();
  return <div>{title}</div>;
}

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <TopBarTitleProbe />
          <TeamActivityView projectId="p1" />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/api/activity-stream')) {
      return { ok: true, status: 200, json: async () => ({ data: { items: [], next_after_seq: null } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  dashCtx.value = {};
  resetOrgMembersCacheForTests();
});

describe('TeamActivityView — 페이지 h1 1개(story #3946)', () => {
  it('⭐h1이 정확히 1개다(TopBarSlot 제목)', async () => {
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});

// story #4231 3차(b · PO 02:34Z) — 활동 항목의 문서 링크는 **그 항목의 프로젝트**(item.project_id)를 싣는다(4241과 같은 규칙).
describe('TeamActivityView — 활동 항목 링크는 자기 프로젝트(story #4231)', () => {
  it('⭐문서 항목 → `/docs?id=d1&p=<항목의 project_id>`', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/activity-stream')) {
        return {
          ok: true, status: 200,
          json: async () => ({ data: { items: [{
            activity_id: 'a1', project_id: 'proj-X', actor_id: null, verb: 'updated', object_type: 'doc', object_id: 'd1',
            occurred_at: new Date().toISOString(), source_event_ids: [], recipient_ids: [], recipient_types: [], payload: {}, activity_seq: 1,
          }], next_after_seq: null } }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/docs?id=d1&p=proj-X');
  });
});

// [SID:4300] 행위자 이름표 = 프로젝트 범위 + 없을 때 조직 범위. 다른 프로젝트 에이전트 · 권한이 회수된 사람이 «알 수 없는 구성원»이
// 아니라 이름으로 선다(유나 판정: 꼬리 없이 이름만). 행위자 필터 선택지(members)는 코드상 프로젝트 범위 그대로(이 카드가 안 바꿈).
describe('TeamActivityView — 행위자 이름 조직 범위 보충([SID:4300])', () => {
  function stub(orgRows: Array<{ id: string; name: string | null; type: string }>) {
    const calls: string[] = [];
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === ORG_NAMES_URL) return { ok: true, status: 200, json: async () => ({ data: orgRows }) };
      if (url.startsWith('/api/members?project_id=')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'om-a', name: '안나', type: 'human' }] }) };
      if (url.includes('/api/activity-stream')) {
        return {
          ok: true, status: 200,
          json: async () => ({ data: { items: [{
            activity_id: 'a1', project_id: 'p1', actor_id: 'ag-other', verb: 'updated', object_type: 'doc', object_id: 'd1',
            occurred_at: new Date().toISOString(), source_event_ids: [], recipient_ids: [], recipient_types: [], payload: {}, activity_seq: 1,
          }], next_after_seq: null } }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    return calls;
  }
  const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it('프로젝트 밖 행위자(다른 프로젝트 에이전트) → 조직 목록 한 번으로 이름', async () => {
    dashCtx.value = { orgId: 'org-1' };
    const calls = stub([{ id: 'ag-other', name: '다른프로젝트봇', type: 'agent' }]);
    await mount();
    await settle();
    expect(container.textContent).toContain('다른프로젝트봇');
    expect(container.textContent).not.toContain('알 수 없는 구성원');
    expect(calls.filter((u) => u === ORG_NAMES_URL)).toHaveLength(1);
  });

  it('조직 목록에도 없으면(BE 원천 대기) «알 수 없는 구성원»', async () => {
    dashCtx.value = { orgId: 'org-1' };
    stub([]);
    await mount();
    await settle();
    expect(container.textContent).toContain('알 수 없는 구성원');
  });
});

// [SID:4311 PR 2] 팀 활동 피드 행의 행위자 — 같은 이름 서로 다른 구성원 둘이면 «· ID 앞 8자»(actor_id마다 한 번 · 시스템 행 제외 ·
// 머리글자는 이름 그대로).
describe('TeamActivityView — 행위자 동명이인([SID:4311 PR 2])', () => {
  it('«송윤재» 둘 = 두 줄에 id 앞 8자 · 같은 사람 두 줄은 겹침 아님 · 시스템 행 문구 그대로 · 머리글자 그대로', async () => {
    const item = (seq: number, actor_id: string | null) => ({
      activity_id: `a${seq}`, project_id: 'p1', actor_id, verb: 'updated', object_type: 'doc', object_id: `d${seq}`,
      occurred_at: new Date().toISOString(), source_event_ids: [], recipient_ids: [], recipient_types: [], payload: {}, activity_seq: seq,
    });
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/members?project_id=')) {
        return { ok: true, status: 200, json: async () => ({ data: [
          { id: 'e75ca548-1', name: '송윤재', type: 'human' },
          { id: '2fd14616-2', name: '송윤재', type: 'human' },
          { id: 'm-anna', name: '안나', type: 'human' },
        ] }) };
      }
      if (url.includes('/api/activity-stream')) {
        return { ok: true, status: 200, json: async () => ({ data: { items: [
          item(5, 'e75ca548-1'), item(4, '2fd14616-2'), item(3, 'm-anna'), item(2, 'm-anna'), item(1, null),
        ], next_after_seq: null } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await mount();
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const rows = [...container.querySelectorAll('li p > span.font-medium')].map((el) => el.textContent);
    expect(rows).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '안나', '안나', koMessages.teamActivity.system]);
    const initials = [...container.querySelectorAll('li > span[aria-hidden]')].map((el) => el.textContent);
    expect(initials.slice(0, 2)).toEqual(['송', '송']);
  });
});
