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

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-B', projectMemberships: [], currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member' }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[data-slot="dialog-portal"], [role="dialog"]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

async function renderAndOpen(entityType: string, entityId: string, data: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data }) })));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <EmbedCard entity_type={entityType} entity_id={entityId} title="대상" status={null} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  return [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
}

describe('#4253 — 태스크 미리보기 부모 스토리 링크는 태스크 자기 프로젝트', () => {
  it('⭐project_id가 오면 부모 링크가 그 프로젝트(현재 B여도 C)', async () => {
    const hrefs = await renderAndOpen('task', 't3', { title: '작업 C', status: 'todo', story_id: 's-parent-3', project_id: 'proj-C' });
    expect(hrefs).toContain('/board?story=s-parent-3&p=proj-C');
    expect(hrefs).not.toContain('/board?story=s-parent-3&p=proj-B');
  });

  it('project_id가 없으면 현재 p(B) 폴백', async () => {
    const hrefs = await renderAndOpen('task', 't4', { title: '작업 D', status: 'todo', story_id: 's-parent-4' });
    expect(hrefs).toContain('/board?story=s-parent-4&p=proj-B');
  });
});

describe('#4253 — 게이트 미리보기 링크는 게이트 자기 프로젝트(GET /api/gates/{id}의 project_id)', () => {
  it('⭐project_id가 오면 /gates/{id} 링크가 그 프로젝트(현재 B여도 C)', async () => {
    const hrefs = await renderAndOpen('gate', 'g-7', { id: 'g-7', status: 'pending', project_id: 'proj-C' });
    expect(hrefs).toContain('/gates/g-7?p=proj-C');
    expect(hrefs).not.toContain('/gates/g-7?p=proj-B');
  });

  it('프로젝트 없는 게이트는 현재 p(B) 폴백(4241 계약)', async () => {
    const hrefs = await renderAndOpen('gate', 'g-8', { id: 'g-8', status: 'pending', project_id: null });
    expect(hrefs).toContain('/gates/g-8?p=proj-B');
  });
});
