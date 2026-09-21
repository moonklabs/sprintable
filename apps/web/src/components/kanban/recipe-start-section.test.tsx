// @vitest-environment jsdom
//
// story #4075([E-RECIPE-1] «레시피 시작») AC1~AC3/AC6/AC7 — story-origin-section.test.tsx와
// 동일 하네스(NextIntlClientProvider + ko.json 실 메시지). fetch 두 축(GET start-candidates·
// POST publish)을 URL로 분기하는 단일 스텁으로 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { RecipeStartSection } from './recipe-start-section';
import type { RecipeStartCandidate } from '@/hooks/use-recipe-start-candidates';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function candidateStub(overrides: Partial<RecipeStartCandidate> = {}): RecipeStartCandidate {
  return {
    definition_id: 'def-1', key: 'org.acme.recipe', name: '테스트 레시피', first_stage: 'draft',
    role_bound: true, started: false, conversation_id: null, message_id: null,
    current_stage: null, current_role: null, next_stage: null, next_role: null, last_published_at: null,
    ...overrides,
  };
}

async function render(candidates: RecipeStartCandidate[], opts: { onPublish?: () => Promise<Response> } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/events/definitions/start-candidates')) {
      return new Response(JSON.stringify({ candidates }));
    }
    if (url === '/api/events/publish' && init?.method === 'POST') {
      return opts.onPublish ? await opts.onPublish() : new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(withIntl(<RecipeStartSection storyId="story-1" projectId="proj-1" />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return fetchMock;
}

describe('RecipeStartSection', () => {
  it('story #4075 AC1(유나 design CHANGES) — 적용 레시피가 0개면 섹션 자체를 렌더하지 않는다(모든 스토리 패널 노이즈 방지)', async () => {
    await render([]);
    expect(container.textContent).toBe('');
  });

  it('AC1 — 레시피는 적용됐지만 첫 단계 역할 미배정이면 그 이유를 보여준다', async () => {
    await render([candidateStub({ role_bound: false })]);
    expect(container.textContent).toContain('첫 단계 담당자가 아직 없어요');
    expect(container.querySelector('a[href="/organization/events"]')).not.toBeNull();
  });

  it('활성 레시피 1개면 바로 시작 버튼 — 클릭하면 POST publish 후 상태를 새로고침한다(AC2)', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/events/definitions/start-candidates')) {
        callCount += 1;
        const started = callCount > 1;
        return new Response(JSON.stringify({
          candidates: [candidateStub({
            started, conversation_id: started ? 'conv-1' : null, message_id: started ? 'msg-1' : null,
            current_stage: started ? 'draft' : null, current_role: started ? '작성자' : null,
            next_stage: started ? 'review' : null, next_role: started ? '검토자' : null,
            last_published_at: started ? '2026-09-21T00:00:00Z' : null,
          })],
        }));
      }
      if (url === '/api/events/publish' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
          definition_key: 'org.acme.recipe',
          payload: { work_item_type: 'story', work_item_id: 'story-1', stage: 'draft' },
        });
        return new Response(JSON.stringify({ conversation_id: 'conv-1', message_id: 'msg-1' }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(withIntl(<RecipeStartSection storyId="story-1" projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const button = container.querySelector('button');
    expect(button?.textContent).toContain('레시피 시작');

    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // story #4082 — «시작됨» 한 줄 대신 현재/다음 단계+마지막 발행 3줄이 뜬다.
    expect(container.textContent).toContain('draft');
    expect(container.textContent).toContain('작성자');
    expect(container.textContent).toContain('review');
    expect(container.querySelector(`a[href="/chats/conv-1?messageId=msg-1"]`)).not.toBeNull();
  });

  it('이미 시작된 스토리는 버튼 대신 진행 상태(현재/다음 단계·대화 링크)를 보인다(AC2, story #4082)', async () => {
    await render([candidateStub({
      started: true, conversation_id: 'conv-9', message_id: 'msg-9',
      current_stage: 'draft', current_role: '작성자', next_stage: 'review', next_role: '검토자',
      last_published_at: '2026-09-21T00:00:00Z',
    })]);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('draft');
    expect(container.textContent).toContain('작성자');
    expect(container.textContent).toContain('review');
    expect(container.textContent).toContain('검토자');
    const link = container.querySelector('a[href^="/chats/conv-9"]');
    expect(link).not.toBeNull();
  });

  it('마지막 단계까지 발행됐으면 다음 단계 대신 «마지막 단계» 문구를 보인다(story #4082)', async () => {
    await render([candidateStub({
      started: true, conversation_id: 'conv-9', message_id: 'msg-9',
      current_stage: 'publish', current_role: '발행자', next_stage: null, next_role: null,
      last_published_at: '2026-09-21T00:00:00Z',
    })]);
    expect(container.textContent).toContain('마지막 단계');
  });

  it('적용 레시피가 2개 이상이면 고르게 한다(선택 전엔 시작 버튼 없음)', async () => {
    await render([
      candidateStub({ key: 'org.acme.a', name: '레시피 A' }),
      candidateStub({ key: 'org.acme.b', name: '레시피 B' }),
    ]);
    expect(container.textContent).toContain('레시피 A');
    expect(container.textContent).toContain('레시피 B');
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(2);
    expect(container.querySelector('button')).toBeNull();

    const radios = container.querySelectorAll('input[type="radio"]');
    await act(async () => { radios[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('발행 실패 시 사용자 문장을 보여준다(AC3, 조용한 삼킴 없음)', async () => {
    await render(
      [candidateStub()],
      { onPublish: async () => new Response(JSON.stringify({ detail: 'boom' }), { status: 500 }) },
    );
    const button = container.querySelector('button')!;
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('projectId가 없으면 아무것도 렌더하지 않는다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(withIntl(<RecipeStartSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
