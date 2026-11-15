// @vitest-environment jsdom
//
// story #4888(UI-5 목표 화면 둘째 조각) — `/epics`(일감 탭줄의 «목표» 탭)는 주소를 그대로 둔 채 «목표 화면»을 스윔레인 보기로 연다.
// 못박는 것: 옛 주소가 살아 있다(404가 아니다) · /goals layout이 하던 컨텍스트(ws · proj · org · project)를 이 페이지가 같게 내려준다 · 스윔레인으로 열린다 · 헤더가 없으면 notFound.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { headerValues, notFoundMock, clientProps } = vi.hoisted(() => ({
  headerValues: new Map<string, string>(),
  notFoundMock: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  clientProps: [] as Array<Record<string, unknown>>,
}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => headerValues.get(k) ?? null }) }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('../goals/goals-client', async () => {
  const { useGoalsRoute } = await import('../goals/goals-context');
  return {
    GoalsClient: (props: Record<string, unknown>) => {
      clientProps.push(props);
      const route = useGoalsRoute();
      return <div data-testid="goals-client-stub" data-route={JSON.stringify(route)} />;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  headerValues.clear();
  clientProps.length = 0;
  notFoundMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('/epics 페이지 — 목표 화면을 스윔레인으로 연다(story #4888 둘째 조각)', () => {
  it('⭐GoalsClient를 initialView="swimlane"으로 그리고 /goals layout과 같은 컨텍스트(ws · proj · projectId · orgId)를 내려준다', async () => {
    headerValues.set('x-resolved-org-id', 'org-9');
    headerValues.set('x-resolved-project-id', 'proj-9');
    const { default: EpicsPage } = await import('./page');
    const el = await EpicsPage({ params: Promise.resolve({ ws: 'my-ws', proj: 'my-proj' }) });
    await act(async () => { root.render(el); });
    const stub = container.querySelector('[data-testid="goals-client-stub"]') as HTMLElement;
    expect(stub).not.toBeNull();
    expect(JSON.parse(stub.getAttribute('data-route')!)).toEqual({ wsSlug: 'my-ws', projSlug: 'my-proj', projectId: 'proj-9', orgId: 'org-9' });
    expect(clientProps[0]).toMatchObject({ projectId: 'proj-9', orgId: 'org-9', initialView: 'swimlane' });
  });

  it('⭐프로젝트나 조직 헤더가 없으면 notFound(예전 /epics는 프로젝트 헤더 없으면 notFound였다 · 조직 헤더는 /goals layout과 같은 규칙)', async () => {
    const { default: EpicsPage } = await import('./page');
    headerValues.set('x-resolved-org-id', 'org-9');
    await expect(EpicsPage({ params: Promise.resolve({ ws: 'w', proj: 'p' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    headerValues.clear();
    headerValues.set('x-resolved-project-id', 'proj-9');
    await expect(EpicsPage({ params: Promise.resolve({ ws: 'w', proj: 'p' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(2);
  });
});
