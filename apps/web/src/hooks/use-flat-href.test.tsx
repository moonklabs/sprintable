// @vitest-environment jsdom
// story #4226 — flat 링크 `?p=` 헬퍼: 기존 쿼리·해시 보존 · 전환 대기 중 목표 → 컨텍스트 유효 프로젝트 순 · 모르면 그대로.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const ctx = { projectId: undefined as string | undefined, inShell: undefined as boolean | undefined };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  ctx.projectId = undefined;
  ctx.inShell = undefined;
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
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

// story #4231 다음 조각(래칫 맹점 ① · PO 15:10Z) — 셸 밖 화면(/today · (v3)/chat · /connect-rules)은 대시보드 컨텍스트에 프로젝트가 없어
// 예전엔 bare였다. 셸 밖에서만 이 탭의 프로젝트(URL ?p= → sessionStorage · 셸과 같은 순서)를 하이드레이션 뒤에 싣는다 · 추가 호출 0.
describe('useFlatHref — 셸 밖은 탭 프로젝트(래칫 맹점 ①)', () => {
  const TAB_KEY = 'sprintable_tab_project_id';

  it('⭐셸 밖 · URL ?p= → 그 프로젝트를 싣는다', async () => {
    window.history.replaceState(null, '', '/today?p=URLP');
    expect(await hrefFor('/inbox?tab=gates')).toBe('/inbox?tab=gates&p=URLP');
  });

  it('⭐셸 밖 · URL p 없음 → sessionStorage(셸이 쓴 이 탭의 프로젝트)', async () => {
    window.history.replaceState(null, '', '/today');
    window.sessionStorage.setItem(TAB_KEY, 'STORED');
    expect(await hrefFor('/chats')).toBe('/chats?p=STORED');
  });

  it('셸 밖 · URL p가 sessionStorage보다 먼저(셸과 같은 순서)', async () => {
    window.history.replaceState(null, '', '/today?p=URLP');
    window.sessionStorage.setItem(TAB_KEY, 'STORED');
    expect(await hrefFor('/chats')).toBe('/chats?p=URLP');
  });

  it('셸 밖 · 탭 값이 둘 다 없으면 주소 그대로(지어내지 않음)', async () => {
    window.history.replaceState(null, '', '/today');
    expect(await hrefFor('/chats')).toBe('/chats');
  });

  it('⭐셸 안은 탭 값을 읽지 않는다(셸 컨텍스트 프로젝트가 정본 · 모르면 지금처럼 그대로)', async () => {
    ctx.inShell = true;
    window.history.replaceState(null, '', '/board?p=URLP');
    window.sessionStorage.setItem(TAB_KEY, 'STORED');
    expect(await hrefFor('/chats')).toBe('/chats');
    ctx.projectId = 'proj-A';
    expect(await hrefFor('/chats')).toBe('/chats?p=proj-A');
  });

  it('⭐서버 렌더는 bare · 하이드레이션 불일치 0 · 하이드레이션 뒤 탭 프로젝트', async () => {
    window.history.replaceState(null, '', '/today?p=URLP');
    const { useFlatHref } = await import('./use-flat-href');
    function Probe() { return <span data-href={useFlatHref()('/chats')} />; }
    const { renderToString } = await import('react-dom/server');
    const html = renderToString(<Probe />);
    expect(html).toContain('data-href="/chats"');
    const el = document.createElement('div');
    el.innerHTML = html;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { hydrateRoot } = await import('react-dom/client');
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => { root = hydrateRoot(el, <Probe />); });
    expect(errors).not.toHaveBeenCalled();
    expect(el.querySelector('span')?.getAttribute('data-href')).toBe('/chats?p=URLP');
    errors.mockRestore();
    await act(async () => { root?.unmount(); });
  });

  it('추가 호출 0(/me 등 fetch 없음)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', '/today?p=URLP');
    await hrefFor('/chats');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
