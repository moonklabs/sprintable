// @vitest-environment jsdom
// story #4226 — flat 링크 `?p=` 헬퍼: 기존 쿼리·해시 보존 · 전환 대기 중 목표 → 컨텍스트 유효 프로젝트 순 · 모르면 그대로.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const ctx = { projectId: undefined as string | undefined };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  ctx.projectId = undefined;
  const { setPendingProjectTarget } = await import('@/lib/pending-project-switch');
  setPendingProjectTarget(null);
});

async function hrefFor(input: string): Promise<string> {
  const { useFlatHref } = await import('./use-flat-href');
  function Probe() { return <span data-href={useFlatHref()(input)} />; }
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () => { root.render(<Probe />); });
  const out = el.querySelector('span')?.getAttribute('data-href') ?? '';
  await act(async () => { root.unmount(); });
  return out;
}

describe('useFlatHref(story #4226)', () => {
  it('withProjectParam — 기존 쿼리·해시 보존 · 이미 실은 p는 그대로(#4231) · 프로젝트 없으면 그대로', async () => {
    const { withProjectParam } = await import('./use-flat-href');
    expect(withProjectParam('/inbox?tab=gates#x', 'P')).toBe('/inbox?tab=gates&p=P#x');
    // story #4231 — 일부러 다른 프로젝트로 보내는 링크(«다른 프로젝트» 대화 · 원래 프로젝트로 돌아가기)를 현재 프로젝트로 덮지 않는다.
    expect(withProjectParam('/chats?p=OTHER', 'P')).toBe('/chats?p=OTHER');
    expect(withProjectParam('/chats/c1?p=OTHER&from=P&pn=x', 'P')).toBe('/chats/c1?p=OTHER&from=P&pn=x');
    expect(withProjectParam('/more', undefined)).toBe('/more');
    // story #4231 3차 — 기존 쿼리 글자는 그대로(재인코딩 없음 · `%20`이 `+`로 안 바뀜).
    expect(withProjectParam('/chats/c1?compose=%ED%95%9C%20%EC%A4%84', 'P')).toBe('/chats/c1?compose=%ED%95%9C%20%EC%A4%84&p=P');
  });

  it('⭐컨텍스트 프로젝트를 싣고 · 전환 대기 중 목표가 있으면 그걸 먼저', async () => {
    ctx.projectId = 'proj-A';
    expect(await hrefFor('/inbox?tab=gates')).toBe('/inbox?tab=gates&p=proj-A');
    const { setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    setPendingProjectTarget('proj-B');
    expect(await hrefFor('/inbox?tab=gates')).toBe('/inbox?tab=gates&p=proj-B');
  });

  it('프로젝트를 모르면 주소 그대로', async () => {
    expect(await hrefFor('/chats')).toBe('/chats');
  });
});
