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
  it('withProjectParam — 기존 쿼리·해시 보존 · 기존 p는 덮어씀 · 프로젝트 없으면 그대로', async () => {
    const { withProjectParam } = await import('./use-flat-href');
    expect(withProjectParam('/inbox?tab=gates#x', 'P')).toBe('/inbox?tab=gates&p=P#x');
    expect(withProjectParam('/chats?p=OLD', 'P')).toBe('/chats?p=P');
    expect(withProjectParam('/more', undefined)).toBe('/more');
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
