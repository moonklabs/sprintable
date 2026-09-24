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
import enMessages from '../../../messages/en.json';
import { RecipeStartSection } from './recipe-start-section';
import type { RecipeStartCandidate } from '@/hooks/use-recipe-start-candidates';

// story #4249 — «이 단계 완료»는 지금 stage 담당이 나일 때만. 기본은 멤버 없음(기존 테스트 무변).
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(() => ({ currentTeamMemberId: undefined as string | undefined })) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
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
    definition_id: 'def-1', key: 'org.acme.recipe', name: '테스트 레시피', org_id: 'org-acme', first_stage: 'draft',
    role_bound: true, started: false, conversation_id: null, message_id: null,
    current_stage: null, current_role: null, next_stage: null, next_role: null, last_published_at: null,
    current_stage_position: null, total_stages: null,
    ...overrides,
  };
}

async function render(candidates: RecipeStartCandidate[], opts: { onPublish?: () => Promise<Response>; locale?: 'ko' | 'en' } = {}) {
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
    root.render(withIntl(<RecipeStartSection storyId="story-1" projectId="proj-1" />, opts.locale));
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
            current_stage: started ? 'draft' : null, current_role: started ? 'Creator' : null,
            next_stage: started ? 'concept_confirmed' : null, next_role: started ? 'Director' : null,
            last_published_at: started ? '2026-09-21T00:00:00Z' : null,
            current_stage_position: started ? 1 : null, total_stages: started ? 9 : null,
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

    // story #4082(유나 design CHANGES) — 「시작됨」 한 줄 대신 현재/다음 단계+마지막 발행
    // 3줄이 뜨고, stage/role은 raw enum이 아니라 recipe-stage-label.ts/stage-role.ts
    // SSOT를 거친 한글 낱말로 뜬다(내부어 노출 0).
    expect(container.textContent).toContain('초안');
    expect(container.textContent).toContain('크리에이터');
    expect(container.textContent).toContain('컨셉 확정');
    expect(container.textContent).toContain('디렉터');
    expect(container.textContent).not.toContain('draft');
    expect(container.textContent).not.toContain('Creator');
    expect(container.querySelector(`a[href="/chats/conv-1?messageId=msg-1"]`)).not.toBeNull();
  });

  it('이미 시작된 스토리는 버튼 대신 진행 상태(한글 단계·역할·대화 링크)를 보인다(AC2, story #4082)', async () => {
    await render([candidateStub({
      started: true, conversation_id: 'conv-9', message_id: 'msg-9',
      current_stage: 'draft', current_role: 'Creator', next_stage: 'concept_confirmed', next_role: 'Director',
      last_published_at: '2026-09-21T00:00:00Z', current_stage_position: 1, total_stages: 9,
    })]);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('초안');
    expect(container.textContent).toContain('크리에이터');
    expect(container.textContent).toContain('컨셉 확정');
    expect(container.textContent).toContain('디렉터');
    const link = container.querySelector('a[href^="/chats/conv-9"]');
    expect(link).not.toBeNull();
  });

  it('마지막 단계까지 발행됐으면 다음 단계 대신 «마지막 단계» 문구를 보인다(story #4082)', async () => {
    await render([candidateStub({
      started: true, conversation_id: 'conv-9', message_id: 'msg-9',
      current_stage: 'published', current_role: 'Publisher', next_stage: null, next_role: null,
      last_published_at: '2026-09-21T00:00:00Z', current_stage_position: 9, total_stages: 9,
    })]);
    expect(container.textContent).toContain('마지막 단계');
  });

  it('story #4082(유나 design CHANGES) — recipe-stage-label.ts 미등재 slug는 raw 노출 대신 «단계 n/9」로 뜬다', async () => {
    await render([candidateStub({
      started: true, conversation_id: 'conv-9', message_id: 'msg-9',
      current_stage: 'some_future_stage_slug', current_role: 'Creator',
      next_stage: 'another_future_stage', next_role: 'Director',
      last_published_at: '2026-09-21T00:00:00Z', current_stage_position: 4, total_stages: 9,
    })]);
    expect(container.textContent).toContain('단계 4/9');
    expect(container.textContent).toContain('단계 5/9');
    expect(container.textContent).not.toContain('some_future_stage_slug');
    expect(container.textContent).not.toContain('another_future_stage');
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

  // story #4091(유나 design 라이브 관찰 ①, PO 확定 2026-09-21) — «켜면 보게» 미충족 처방:
  // 시작된 레시피가 2개 이상 적용된 상태 중 하나여도, 라디오 선택 없이 그 진행 3줄이
  // 바로 보인다(선택은 «아직 안 시작한 것을 골라 시작»에만 관여).
  it('적용 레시피 2개 중 1개가 이미 시작됐으면, 선택 없이도 그 항목 아래 진행 3줄이 바로 보인다(story #4091 AC1)', async () => {
    await render([
      candidateStub({
        key: 'org.acme.a', name: '레시피 A', started: true, conversation_id: 'conv-a', message_id: 'msg-a',
        current_stage: 'draft', current_role: 'Creator', next_stage: 'concept_confirmed', next_role: 'Director',
        last_published_at: '2026-09-21T00:00:00Z', current_stage_position: 1, total_stages: 9,
      }),
      candidateStub({ key: 'org.acme.b', name: '레시피 B' }),
    ]);
    // 시작된 레시피 A의 진행 3줄 — 라디오를 하나도 안 눌렀는데 바로 보인다.
    expect(container.textContent).toContain('레시피 A');
    expect(container.textContent).toContain('초안');
    expect(container.textContent).toContain('컨셉 확정');
    const conversationLink = container.querySelector('a[href^="/chats/conv-a"]');
    expect(conversationLink).not.toBeNull();
    // 시작 안 한 후보가 레시피 B 하나뿐이라 라디오 없이 자동 선택(#4075 단일 후보 관례,
    // 시작된 A는 애초 라디오 목록 대상이 아니다) — 시작 버튼이 바로 뜬다.
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(0);
    expect(container.querySelector('button')?.textContent).toContain('레시피 시작');
  });

  it('적용 레시피 2개가 전부 이미 시작됐으면 라디오 없이 둘 다 진행 3줄이 각각 보인다(story #4091 AC1)', async () => {
    await render([
      candidateStub({
        key: 'org.acme.a', name: '레시피 A', started: true, conversation_id: 'conv-a', message_id: 'msg-a',
        current_stage: 'draft', current_role: 'Creator', next_stage: 'concept_confirmed', next_role: 'Director',
        last_published_at: '2026-09-21T00:00:00Z', current_stage_position: 1, total_stages: 9,
      }),
      candidateStub({
        key: 'org.acme.b', name: '레시피 B', started: true, conversation_id: 'conv-b', message_id: 'msg-b',
        current_stage: 'animatic', current_role: 'Creator', next_stage: 'structure_passed', next_role: 'Director',
        last_published_at: '2026-09-21T00:00:00Z', current_stage_position: 3, total_stages: 9,
      }),
    ]);
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(0);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('레시피 A');
    expect(container.textContent).toContain('레시피 B');
    expect(container.querySelector('a[href^="/chats/conv-a"]')).not.toBeNull();
    expect(container.querySelector('a[href^="/chats/conv-b"]')).not.toBeNull();
  });

  // story #4261(4075 AC7 개정) — 다른 탭 · 새로고침 전 화면에서 누르면 BE가 409 RECIPE_ALREADY_STARTED. 에러가 아니라 상태 —
  // 다시 읽어 진행 상태로(알림 없음 · 메시지는 새로 안 생김).
  it('⭐이미 시작된 회차에 시작을 누르면(409 RECIPE_ALREADY_STARTED) 에러 없이 진행 상태로 돌아간다', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/events/definitions/start-candidates')) {
        callCount += 1;
        const started = callCount > 1; // 첫 화면은 아직 모름(다른 탭이 방금 시작)
        return new Response(JSON.stringify({
          candidates: [candidateStub({
            started, conversation_id: started ? 'conv-1' : null, message_id: started ? 'msg-1' : null,
            current_stage: started ? 'draft' : null, current_role: started ? 'Creator' : null,
            next_stage: started ? 'concept_confirmed' : null, next_role: started ? 'Director' : null,
            last_published_at: started ? '2026-09-21T00:00:00Z' : null,
            current_stage_position: started ? 1 : null, total_stages: started ? 9 : null,
          })],
        }));
      }
      if (url === '/api/events/publish' && init?.method === 'POST') {
        // 실제 봉투(유나 측정 · 까디르 P2와 같은 부류): /api/events/publish는 proxyToFastapi → BE http_exception_handler가
        // HTTPException(detail=dict)을 {data: null, error: {code, message, …}, meta: null}로 싼다 — {detail} 모양이 아니다.
        return new Response(JSON.stringify({ data: null, error: {
          code: 'RECIPE_ALREADY_STARTED', reason: 'already_started', message: '이 스토리에서 이 레시피는 이미 시작됐어요.', conversation_id: 'conv-1', message_id: 'msg-1',
          current_stage: 'draft', is_last_stage: false,
        }, meta: null }), { status: 409 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(withIntl(<RecipeStartSection storyId="story-1" projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const button = container.querySelector('button');
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('초안');
    expect(container.querySelector(`a[href="/chats/conv-1?messageId=msg-1"]`)).not.toBeNull();
  });

  it('발행 실패 시 사용자 문장을 보여준다(AC3, 조용한 삼킴 없음)', async () => {
    await render(
      [candidateStub()],
      // 실제 봉투(BE 에러 핸들러) — {data: null, error: {code, message}, meta: null}.
      { onPublish: async () => new Response(JSON.stringify({ data: null, error: { code: 'INTERNAL_ERROR', message: 'boom' }, meta: null }), { status: 500 }) },
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

// story #4202 — «레시피 시작» 칸도 플랫폼 마케팅 프리셋(org_id null)은 로케일 문안, 조직 정의는 원문.
describe('RecipeStartSection — 플랫폼 프리셋 이름 로케일(story #4202)', () => {
  const PLATFORM = { key: 'preset.marketing.video_production', name: '영상 제작(릴스·쇼츠)', org_id: null };

  it('en — 시작 전 한 줄: 플랫폼은 영어 이름, 조직 정의는 원문', async () => {
    await render([
      candidateStub({ definition_id: 'p1', ...PLATFORM }),
      candidateStub({ definition_id: 'o1', key: 'org.acme.video', name: '우리 영상 흐름', org_id: 'org-acme' }),
    ], { locale: 'en' });
    const text = container.textContent ?? '';
    expect(text).toContain(enMessages.recipePreset.videoProductionName);
    expect(text).not.toContain('영상 제작(릴스·쇼츠)');
    expect(text).toContain('우리 영상 흐름');
  });

  it('en — 진행 중 둘 이상일 때 진행 줄 제목도 영어 이름', async () => {
    const started = { started: true, current_stage: 'draft', current_role: '크리에이터', current_stage_position: 1, total_stages: 3 };
    await render([
      candidateStub({ definition_id: 'p1', ...PLATFORM, ...started }),
      candidateStub({ definition_id: 'o1', key: 'org.acme.video', name: '우리 영상 흐름', org_id: 'org-acme', ...started }),
    ], { locale: 'en' });
    const titles = [...container.querySelectorAll('p.font-medium')].map((e) => e.textContent);
    expect(titles).toContain(enMessages.recipePreset.videoProductionName);
    expect(titles).toContain('우리 영상 흐름');
    expect(container.textContent).not.toContain('영상 제작(릴스·쇼츠)');
  });

  // story #4273(유나 처방) — 시작 전 후보가 하나여도 버튼 바로 위에 그 레시피 이름(여럿일 때 라디오 라벨과 같은 presetName).
  it('⭐진행 중 레시피 아래 시작 전 후보가 하나면 — 버튼 바로 위에 그 후보 이름(위 진행 레시피를 다시 시작으로 읽히지 않게 · 4167 자리)', async () => {
    await render([
      candidateStub({ definition_id: 'p1', ...PLATFORM, started: true, current_stage: 'draft', current_role: '크리에이터', current_stage_position: 1, total_stages: 3 }),
      candidateStub({ definition_id: 'o1', key: 'org.acme.pipeline', name: '마케팅 콘텐츠 파이프라인', org_id: 'org-acme' }),
    ]);
    const nameLine = container.querySelector('[data-testid="recipe-start-name"]');
    expect(nameLine?.textContent).toBe('마케팅 콘텐츠 파이프라인');
    expect(nameLine?.nextElementSibling?.tagName).toBe('BUTTON');
    expect(nameLine?.nextElementSibling?.textContent).toContain(koMessages.board.recipeStartButton);
  });

  it('시작 전 후보 하나뿐(진행 중 없음)이어도 이름 — ko 원문 · en은 플랫폼 영어 이름', async () => {
    await render([candidateStub()]);
    expect(container.querySelector('[data-testid="recipe-start-name"]')?.textContent).toBe('테스트 레시피');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render([candidateStub({ definition_id: 'p1', ...PLATFORM })], { locale: 'en' });
    const en = container.querySelector('[data-testid="recipe-start-name"]')?.textContent;
    expect(en).toBe(enMessages.recipePreset.videoProductionName);
  });

  it('시작 전 후보가 여럿이면 이름 줄 대신 라디오 라벨(규칙 하나 · 이름이 두 번 뜨지 않음)', async () => {
    await render([candidateStub({ key: 'org.acme.a', name: '레시피 A' }), candidateStub({ key: 'org.acme.b', name: '레시피 B' })]);
    expect(container.querySelector('[data-testid="recipe-start-name"]')).toBeNull();
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(2);
  });
});


// story #4249 — 사람이 자기 stage를 끝내는 행동(스토리 레시피 구역) · 문안·상태 흐름은 유나 확정.
describe('RecipeStartSection — 이 단계 완료(story #4249)', () => {
  const B = koMessages.board;
  const O = koMessages.organization;
  const startedStub = (overrides: Partial<RecipeStartCandidate> = {}) => candidateStub({
    started: true, conversation_id: 'conv-1', message_id: 'msg-1', current_stage: 'assign_step_1', next_stage: 'submit_step_1',
    current_stage_position: 1, total_stages: 3, current_bound_member_id: 'me-1', current_completion: 'complete', ...overrides,
  });

  async function renderWith(
    candidates: RecipeStartCandidate[] | (() => RecipeStartCandidate[]),
    onComplete?: (body: unknown) => Response,
  ) {
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1' });
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/events/definitions/start-candidates')) {
        return new Response(JSON.stringify({ candidates: typeof candidates === 'function' ? candidates() : candidates }));
      }
      if (url === '/api/events/definitions/def-1/complete-stage' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        return onComplete ? onComplete(body) : new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(withIntl(<RecipeStartSection storyId="story-1" projectId="proj-1" />)); });
    await flushAll();
    return { fetchMock, bodies };
  }
  const flushAll = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };
  const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await flushAll(); };
  const confirmYes = () => [...container.querySelectorAll('[data-testid="recipe-complete-confirm"] button')].find((b) => b.textContent === B.recipeCompleteStageConfirmYes)!;
  const remount = async () => { await act(async () => { root.unmount(); }); root = createRoot(container); };

  afterEach(() => { useDashboardContextMock.mockReturnValue({ currentTeamMemberId: undefined }); });

  it('내 stage → 버튼 → «{다음 단계} 단계로 넘길까요?» → 넘기기 → POST(complete) → 새 현재 단계가 보일 때까지 «넘겼어요»', async () => {
    // 새로고침 응답은 계속 옛 단계 — 서버 반영 전에도 버튼이 다시 떠 두 번 발행되지 않는지를 잰다.
    const { bodies } = await renderWith(() => [startedStub()]);
    const button = container.querySelector('[data-testid="recipe-complete-stage"]');
    expect(button?.textContent).toBe(B.recipeCompleteStage);
    await click(button);
    expect(container.querySelector('[data-testid="recipe-complete-confirm"]')?.textContent)
      .toContain(B.recipeCompleteStageConfirm.replace('{next}', O.recipeStageLabelSubmitStep1));
    await click(confirmYes());
    expect(bodies).toEqual([{ project_id: 'proj-1', work_item_type: 'story', work_item_id: 'story-1', stage: 'assign_step_1', action: 'complete' }]);
    // 새로고침 응답이 아직 옛 단계면 버튼 대신 «넘겼어요» 한 줄
    expect(container.querySelector('[data-testid="recipe-stage-advanced"]')?.textContent).toBe(B.recipeCompletedStage);
    expect(container.querySelector('[data-testid="recipe-complete-stage"]')).toBeNull();
  });

  it('다음 단계 라벨이 없으면 이름 없는 확인 줄', async () => {
    await renderWith([startedStub({ next_stage: 'my_custom_step' })]);
    await click(container.querySelector('[data-testid="recipe-complete-stage"]'));
    expect(container.querySelector('[data-testid="recipe-complete-confirm"]')?.textContent).toContain(B.recipeCompleteStageConfirmUnnamed);
  });

  it('남의 stage면 버튼 0 · 마지막 단계 안내 · 입력 필요 안내', async () => {
    await renderWith([startedStub({ current_bound_member_id: 'agent-9' })]);
    expect(container.querySelector('[data-testid="recipe-complete-stage"]')).toBeNull();
    await remount();
    await renderWith([startedStub({ current_completion: 'last_stage', next_stage: null })]);
    expect(container.querySelector('[data-testid="recipe-last-stage-hint"]')?.textContent).toBe(B.recipeLastStageHint);
    expect(container.querySelector('[data-testid="recipe-complete-stage"]')).toBeNull();
    await remount();
    await renderWith([startedStub({ current_completion: 'needs_fields' })]);
    expect(container.querySelector('[data-testid="recipe-needs-fields-hint"]')?.textContent).toBe(B.recipeNeedsFieldsHint);
  });

  it('게이트 승인 뒤 다음 stage가 내 것 → «다음 단계 시작»(start · 확인 없음) · 승인 전엔 대기 안내', async () => {
    const gate = { current_bound_member_id: 'director-1', current_completion: 'gate_approval' as const, next_bound_member_id: 'me-1' };
    await renderWith([startedStub({ ...gate, current_gate_status: 'pending' })]);
    expect(container.querySelector('[data-testid="recipe-start-my-stage-waiting"]')?.textContent).toBe(B.recipeStartMyStageWaiting);
    await remount();
    const { bodies } = await renderWith([startedStub({ ...gate, current_gate_status: 'approved' })]);
    expect(container.querySelector('[data-testid="recipe-start-my-stage"]')?.textContent).toBe(B.recipeStartMyStage);
    await click(container.querySelector('[data-testid="recipe-start-my-stage"]'));
    expect(bodies).toEqual([{ project_id: 'proj-1', work_item_type: 'story', work_item_id: 'story-1', stage: 'submit_step_1', action: 'start' }]);
  });

  it('409 «이미 넘어갔어요» · 403 «담당 아님»은 상태 알림 + 구역 다시 읽기 · 그 밖은 서버 메시지 · 없으면 실패 문장', async () => {
    const cases: [number, unknown, string, 'status' | 'alert'][] = [
      [409, { detail: { code: 'STAGE_NOT_CURRENT' } }, B.recipeStageActionAlreadyMoved, 'status'],
      [403, { detail: { code: 'NOT_STAGE_ASSIGNEE' } }, B.recipeStageActionNotAssignee, 'status'],
      [500, {}, B.recipeStageActionFailed, 'alert'],
    ];
    for (const [status, payload, text, role] of cases) {
      await remount();
      const { fetchMock } = await renderWith([startedStub()], () => new Response(JSON.stringify(payload), { status }));
      await click(container.querySelector('[data-testid="recipe-complete-stage"]'));
      await click(confirmYes());
      const notice = container.querySelector('[data-testid="recipe-stage-action-notice"]');
      expect(notice?.textContent).toBe(text);
      expect(notice?.getAttribute('role')).toBe(role);
      const reloads = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/events/definitions/start-candidates')).length;
      expect(reloads).toBe(status === 500 ? 1 : 2);
    }
  });
});
