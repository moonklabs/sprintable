// @vitest-environment jsdom
//
// story #4253(까디르 codex · PO 09:45Z · 델타 01a0d316) — 채팅은 조직 전체가 보는 자리라 미리보기 링크는 «대상 자기 프로젝트». 화면(현재 p)은
// B로 둬서 «대상 프로젝트를 모르면 현재 p» 폴백까지 값으로 가른다(현재 p가 비면 폴백과 «아무것도 안 실음»이 구별되지 않는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EmbedCard } from './embed-card';
import koMessages from '../../../messages/ko.json';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-B', projectMemberships: [], currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member' }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[data-slot="dialog-portal"], [role="dialog"]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

/** URL 앞부분 → 응답 본문(각 라우트의 **실제** 모양 그대로 — 게이트 단건은 proxyToFastapi라 날 GateResponse, 나머지는 {data}). */
function stubRoutes(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    return key ? { ok: true, json: async () => routes[key] } : { ok: false, json: async () => ({}) };
  }));
}

async function flush() {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

async function renderCard(entityType: string, entityId: string) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <EmbedCard entity_type={entityType} entity_id={entityId} title="대상" status={null} />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

async function clickButton(index = 0) {
  await act(async () => {
    container.querySelectorAll('button')[index]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}

const hrefs = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));

async function renderAndOpen(entityType: string, entityId: string, routes: Record<string, unknown>) {
  stubRoutes(routes);
  await renderCard(entityType, entityId);
  await clickButton(0);
  return hrefs();
}

describe('#4253 — 태스크 미리보기 부모 스토리 링크는 태스크 자기 프로젝트', () => {
  it('⭐project_id가 오면 부모 링크가 그 프로젝트(현재 B여도 C)', async () => {
    const hrefs = await renderAndOpen('task', 't3', { '/api/tasks/': { data: { title: '작업 C', status: 'todo', story_id: 's-parent-3', project_id: 'proj-C' } } });
    expect(hrefs).toContain('/board?story=s-parent-3&p=proj-C');
    expect(hrefs).not.toContain('/board?story=s-parent-3&p=proj-B');
  });

  it('project_id가 없으면 현재 p(B) 폴백', async () => {
    const hrefs = await renderAndOpen('task', 't4', { '/api/tasks/': { data: { title: '작업 D', status: 'todo', story_id: 's-parent-4' } } });
    expect(hrefs).toContain('/board?story=s-parent-4&p=proj-B');
  });
});

// 까디르 codex 01a0d35f P1 — /api/gates/[id]는 proxyToFastapi(감싸지 않음)라 BE GateResponse 날 JSON이 온다. 목도 그 모양(예전 목은 {data}라 가렸다).
describe('#4253 — 게이트 미리보기 링크는 게이트 자기 프로젝트(GET /api/gates/{id}의 project_id · 날 JSON)', () => {
  it('⭐project_id가 오면 /gates/{id} 링크가 그 프로젝트(현재 B여도 C)', async () => {
    const hrefs = await renderAndOpen('gate', 'g-7', { '/api/gates/': { id: 'g-7', status: 'pending', project_id: 'proj-C' } });
    expect(hrefs).toContain('/gates/g-7?p=proj-C');
    expect(hrefs).not.toContain('/gates/g-7?p=proj-B');
  });

  it('프로젝트 없는 게이트는 현재 p(B) 폴백(4241 계약)', async () => {
    const hrefs = await renderAndOpen('gate', 'g-8', { '/api/gates/': { id: 'g-8', status: 'pending', project_id: null } });
    expect(hrefs).toContain('/gates/g-8?p=proj-B');
  });
});

// 까디르 codex 01a0d35f P2 — 문서 프로젝트 id는 아는데 project_slug가 없으면(옛 미백필) 현재 p로 떨어지던 세 자리.
describe('#4253 — slug 없는 문서도 문서 자기 프로젝트(docs/preview의 projectId)', () => {
  const docPreview = (projectId?: string) => ({ data: { slug: 'my-doc', orgSlug: 'acme', projectSlug: null, ...(projectId ? { projectId } : {}) } });

  it('⭐문서 카드 주 클릭(이동) — /docs/{slug}/view?p=문서 프로젝트', async () => {
    stubRoutes({ '/api/docs/preview': docPreview('proj-C') });
    await renderCard('doc', 'doc-1');
    await clickButton(0);
    expect(pushMock).toHaveBeenCalledWith('/docs/my-doc/view?p=proj-C');
  });

  it('문서 카드 주 클릭 — 문서 프로젝트를 모르면 현재 p(B)', async () => {
    stubRoutes({ '/api/docs/preview': docPreview() });
    await renderCard('doc', 'doc-2');
    await clickButton(0);
    expect(pushMock).toHaveBeenCalledWith('/docs/my-doc/view?p=proj-B');
  });

  it('⭐문서 미리보기(모달) 링크 — /docs/{slug}/view?p=문서 프로젝트', async () => {
    stubRoutes({ '/api/docs/preview': docPreview('proj-C'), '/api/docs': { data: [{ id: 'doc-3', slug: 'my-doc', title: '문서', content: '' }] } });
    await renderCard('doc', 'doc-3');
    await clickButton(1);
    expect(hrefs()).toContain('/docs/my-doc/view?p=proj-C');
  });

  it('⭐아티팩트의 부모 문서 링크 — /docs?id=…&p=문서 프로젝트', async () => {
    stubRoutes({
      '/api/visual-artifacts/preview': { data: { projectId: 'proj-A' } },
      '/api/visual-artifacts/art-1': { data: { id: 'art-1', title: '아티팩트', doc_id: 'd-9' } },
      '/api/docs/preview': { data: { slug: 'parent-doc', orgSlug: 'acme', projectSlug: null, projectId: 'proj-C' } },
    });
    await renderCard('artifact', 'art-1');
    await clickButton(0);
    expect(hrefs()).toContain('/docs?id=d-9&p=proj-C');
  });
});

// story #4253(유나 4612 비차단 · PO 14:28Z) — 슬러그로 스코프드 경로를 못 지을 때(project_slug 없음) resolveScopedEntityHref의 폴백이 bare로
// 나가지 않는다: 응답의 항목(부모) 프로젝트 id → `?p=`. 다섯 자리(태스크 · 아티팩트 스토리/목표 · 증거 · 스토리 자기).
describe('#4253 — 미리보기 «전체 보기» 폴백은 항목 자기 프로젝트(slug 없음)', () => {
  const noSlug = { org_slug: 'acme', project_slug: null, project_id: 'proj-C' };

  it('⭐태스크 → 부모 스토리 /board?story=…&p=proj-C', async () => {
    const hrefs = await renderAndOpen('task', 't-9', { '/api/tasks/': { data: { title: 'T', status: 'todo', story_id: 's-9', ...noSlug } } });
    expect(hrefs).toContain('/board?story=s-9&p=proj-C');
  });

  it('⭐아티팩트 → 스토리 · 목표', async () => {
    let hrefs = await renderAndOpen('artifact', 'art-2', {
      '/api/visual-artifacts/preview': { data: { projectId: 'proj-C' } },
      '/api/visual-artifacts/art-2': { data: { id: 'art-2', title: 'A', story_id: 's-2', ...noSlug } },
    });
    expect(hrefs).toContain('/board?story=s-2&p=proj-C');
    await act(async () => { root.unmount(); });
    document.querySelectorAll('[data-slot="dialog-portal"], [role="dialog"]').forEach((el) => el.remove());
    root = createRoot(container);
    hrefs = await renderAndOpen('artifact', 'art-3', {
      '/api/visual-artifacts/preview': { data: { projectId: 'proj-C' } },
      '/api/visual-artifacts/art-3': { data: { id: 'art-3', title: 'A', epic_id: 'e-3', ...noSlug } },
    });
    expect(hrefs).toContain('/goals/e-3?p=proj-C');
  });

  it('⭐증거 → 해소된 스토리', async () => {
    const hrefs = await renderAndOpen('evidence', 'ev-1', { '/api/evidence/': { data: { resolved_story_id: 's-4', ...noSlug } } });
    expect(hrefs).toContain('/board?story=s-4&p=proj-C');
  });

  it('⭐스토리 자기 링크 — 응답 project_id가 있으면 그 프로젝트(현재 B여도 C)', async () => {
    const hrefs = await renderAndOpen('story', 's-5', { '/api/stories/': { data: { title: 'S', status: 'todo', ...noSlug } } });
    expect(hrefs).toContain('/board?story=s-5&p=proj-C');
    expect(hrefs).not.toContain('/board?story=s-5&p=proj-B');
  });

  it('태스크 — 응답에 프로젝트가 없으면 현재 p(B) 폴백', async () => {
    const hrefs = await renderAndOpen('task', 't-8', { '/api/tasks/': { data: { title: 'T', status: 'todo', story_id: 's-8', org_slug: 'acme', project_slug: null } } });
    expect(hrefs).toContain('/board?story=s-8&p=proj-B');
  });
});
