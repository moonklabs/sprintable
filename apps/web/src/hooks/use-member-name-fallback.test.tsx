// @vitest-environment jsdom
//
// [SID:4300] 이름표 = 프로젝트 범위 + 없을 때 조직 범위. 실 렌더로 고정: 다 풀리면 조직 목록 요청 0 · 없는 id가 보이면
// 한 번 받아 빈 칸만 채움(프로젝트 값이 이김) · 받는 동안 loaded=false(«알 수 없음» 먼저 뜨지 않게) · 실패하면 loaded=true ·
// 같은 org 두 화면은 한 요청 · org가 바뀌면 옛 org 표를 안 씀 · 프로젝트 표를 받기 전엔 판단 안 함.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ORG_NAMES_URL, resetOrgMembersCacheForTests, useMemberNameFallback } from './use-member-name-fallback';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  resetOrgMembersCacheForTests();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

type M = { id: string; name: string | null; type: string };
const PROJECT: Record<string, M> = {
  'om-a': { id: 'om-a', name: '안나', type: 'human' },
};
const ORG_ROWS = [
  { id: 'om-a', name: '안나(조직 표)', type: 'human' },
  { id: 'om-revoked', name: '권회수', type: 'human' },
  { id: 'ag-other', name: '다른프로젝트봇', type: 'agent' },
];

function orgOk(rows = ORG_ROWS) {
  return { ok: true, status: 200, json: async () => ({ data: rows }) };
}

const seen: Array<{ loaded: boolean; names: Record<string, string | null | undefined> }> = [];

function Harness({ orgId, ids, projectLoaded = true, project = PROJECT }: { orgId?: string; ids: string[]; projectLoaded?: boolean; project?: Record<string, M> }) {
  const { memberMap, loaded } = useMemberNameFallback(orgId, project, ids, projectLoaded);
  const names: Record<string, string | null | undefined> = {};
  for (const id of ids) names[id] = Object.hasOwn(memberMap, id) ? memberMap[id]!.name : undefined;
  seen.push({ loaded, names });
  return <div data-loaded={String(loaded)}>{ids.map((id) => <span key={id} data-id={id}>{names[id] ?? '∅'}</span>)}</div>;
}

const text = (id: string) => container.querySelector(`[data-id="${id}"]`)?.textContent;
const loadedAttr = () => container.firstElementChild?.getAttribute('data-loaded');
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => { seen.length = 0; });

describe('useMemberNameFallback', () => {
  it('조직 원천은 비활성 에이전트까지 싣는 조직 범위 팀원 목록(기존 include_inactive 인자 · 새 BE 0)', () => {
    // 비활성 에이전트도 «목록이 거른 것»이지 «모름»이 아니다(유나 판정) — /api/members(조직 갈래)는 활성만이라 쓰지 않는다.
    expect(ORG_NAMES_URL).toBe('/api/team-members?include_inactive=true');
  });

  it('보이는 id가 전부 프로젝트 표에 있으면 조직 목록 요청 0 · loaded=true', async () => {
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-a']} />); });
    await flush();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(text('om-a')).toBe('안나');
    expect(loadedAttr()).toBe('true');
  });

  it('없는 id가 보이면 조직 목록(ORG_NAMES_URL · 비활성 포함)을 한 번 받아 빈 칸만 채운다 — 프로젝트 값이 이긴다', async () => {
    fetchWithAuthMock.mockResolvedValue(orgOk());
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-a', 'om-revoked', 'ag-other']} />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenCalledWith(ORG_NAMES_URL);
    expect(text('om-a')).toBe('안나');
    expect(text('om-revoked')).toBe('권회수');
    expect(text('ag-other')).toBe('다른프로젝트봇');
    expect(loadedAttr()).toBe('true');
  });

  it('받는 동안은 loaded=false — 어떤 렌더에서도 «없음 + loaded=true»가 먼저 서지 않는다', async () => {
    let resolve!: (v: unknown) => void;
    fetchWithAuthMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-revoked']} />); });
    expect(loadedAttr()).toBe('false');
    await act(async () => { resolve(orgOk()); });
    await flush();
    expect(text('om-revoked')).toBe('권회수');
    expect(seen.some((s) => s.loaded && s.names['om-revoked'] === undefined)).toBe(false);
  });

  it('조직 원천이 떠난 사람도 이름만 실으면(4303 · PR 4658: user_id null · is_active false) 그 이름을 쓴다 — 거르지 않는다', async () => {
    fetchWithAuthMock.mockResolvedValue(orgOk([{ id: 'om-left', name: '떠난이', type: 'human', user_id: null, is_active: false, role: 'member' } as never]));
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-left']} />); });
    await flush();
    expect(text('om-left')).toBe('떠난이');
    expect(loadedAttr()).toBe('true');
  });

  it('조직 목록에도 없으면 비어 있고 loaded=true(«알 수 없는 구성원» 자리)', async () => {
    fetchWithAuthMock.mockResolvedValue(orgOk());
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-gone']} />); });
    await flush();
    expect(text('om-gone')).toBe('∅');
    expect(loadedAttr()).toBe('true');
  });

  it('조직 목록이 실패하면 loaded=true(빈 칸 = «알 수 없는 구성원») · 다음 화면은 다시 시도', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-revoked']} />); });
    await flush();
    expect(loadedAttr()).toBe('true');
    expect(text('om-revoked')).toBe('∅');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuthMock.mockResolvedValueOnce(orgOk());
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-revoked']} />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(text('om-revoked')).toBe('권회수');
  });

  it('같은 org의 두 화면은 조직 목록을 한 요청으로 나눠 쓴다', async () => {
    fetchWithAuthMock.mockResolvedValue(orgOk());
    await act(async () => {
      root.render(<><Harness orgId="org-1" ids={['om-revoked']} /><Harness orgId="org-1" ids={['ag-other']} /></>);
    });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('프로젝트 표를 받기 전엔 «없음»을 판단하지 않는다(요청 0 · loaded=false)', async () => {
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-revoked']} project={{}} projectLoaded={false} />); });
    await flush();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(loadedAttr()).toBe('false');
  });

  it('orgId가 없으면 조직 목록을 안 받는다(프로젝트 표만 · loaded=true)', async () => {
    await act(async () => { root.render(<Harness ids={['om-revoked']} />); });
    await flush();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(loadedAttr()).toBe('true');
  });

  it('org-1 실패 뒤 org-2로 바뀌면 옛 실패가 새 org를 loaded로 보이게 하지 않는다', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-revoked']} />); });
    await flush();
    expect(loadedAttr()).toBe('true');
    seen.length = 0;
    let resolve!: (v: unknown) => void;
    fetchWithAuthMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await act(async () => { root.render(<Harness orgId="org-2" ids={['om-revoked']} />); });
    expect(seen.every((s) => !s.loaded)).toBe(true);
    await act(async () => { resolve(orgOk()); });
    await flush();
    expect(text('om-revoked')).toBe('권회수');
  });

  it('org가 바뀌면 옛 org 표를 안 쓰고 새 org로 다시 받는다', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(orgOk());
    await act(async () => { root.render(<Harness orgId="org-1" ids={['om-revoked']} />); });
    await flush();
    expect(text('om-revoked')).toBe('권회수');
    let resolve!: (v: unknown) => void;
    fetchWithAuthMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await act(async () => { root.render(<Harness orgId="org-2" ids={['om-revoked']} />); });
    expect(text('om-revoked')).toBe('∅');
    expect(loadedAttr()).toBe('false');
    await act(async () => { resolve(orgOk([{ id: 'om-revoked', name: '둘째조직', type: 'human' }])); });
    await flush();
    expect(text('om-revoked')).toBe('둘째조직');
  });
});
