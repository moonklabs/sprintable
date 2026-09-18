// @vitest-environment jsdom
//
// story c7abdf42 — 반복 스케줄 프로젝트 설정 섹션. organization/connectors/page.test.tsx와
// 동형 harness(NextIntlClientProvider·createRoot·vi.stubGlobal('fetch', ...)). EntityChip이
// 내부적으로 useDashboardContext를 호출하므로 그 모킹도 함께 둔다(이 섹션 자신은 안 씀).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import { RecurringRecipesSection } from './recurring-recipes-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const PROJECT_ID = 'proj-1';

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [], projectMemberships: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ACTIVE_ROW = {
  id: 'sched-1', project_id: PROJECT_ID, definition_key: 'org.x.weekly', definition_title: '주간 리포트',
  repeat: 'P7D', next_run_at: '2026-09-09T00:00:00Z', last_run_at: '2026-09-02T00:00:00Z',
  last_story_reference_token: '[회차 3](entity:story:70c6e3be-d489-4d2c-b61b-e0c11d533b66)',
  status: 'active', pause_reason: null, consecutive_failure_count: 0,
};

const PAUSED_ROW = {
  ...ACTIVE_ROW, id: 'sched-2', status: 'paused', pause_reason: '연속 3회 발행 실패', consecutive_failure_count: 3,
};

function stubFetch(handlers: Record<string, () => { ok: boolean; status: number; json: () => Promise<unknown> }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${url}`;
      const handler = handlers[key];
      if (!handler) throw new Error('unexpected fetch: ' + key);
      return handler();
    }),
  );
}

describe('RecurringRecipesSection — 조회(story c7abdf42)', () => {
  it('0건 — 안내 문구', async () => {
    stubFetch({ [`GET /api/projects/${PROJECT_ID}/repeat-schedules`]: () => ({ ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) }) });
    await act(async () => { root.render(wrap(<RecurringRecipesSection projectId={PROJECT_ID} />)); });
    await flush();
    expect(container.textContent).toContain(koMessages.settings.repeatSchedulesEmpty);
  });

  it('행 렌더 — 정의 제목·repeat·상태·직전 회차 스토리 참조 칩', async () => {
    stubFetch({ [`GET /api/projects/${PROJECT_ID}/repeat-schedules`]: () => ({ ok: true, status: 200, json: async () => ({ data: [ACTIVE_ROW], error: null, meta: null }) }) });
    await act(async () => { root.render(wrap(<RecurringRecipesSection projectId={PROJECT_ID} />)); });
    await flush();
    expect(container.textContent).toContain('주간 리포트');
    expect(container.textContent).toContain('P7D');
    expect(container.textContent).toContain(koMessages.settings.repeatSchedulesStatusActive);
    // EntityChip이 마크다운 라벨(회차 3)을 그대로 노출 — 원시 reference_token 문자열이 아니라.
    expect(container.textContent).toContain('회차 3');
    expect(container.textContent).not.toContain('entity:story:');
  });

  it('paused 행 — 정지 사유가 보인다', async () => {
    stubFetch({ [`GET /api/projects/${PROJECT_ID}/repeat-schedules`]: () => ({ ok: true, status: 200, json: async () => ({ data: [PAUSED_ROW], error: null, meta: null }) }) });
    await act(async () => { root.render(wrap(<RecurringRecipesSection projectId={PROJECT_ID} />)); });
    await flush();
    expect(container.textContent).toContain(koMessages.settings.repeatSchedulesStatusPaused);
    expect(container.textContent).toContain('연속 3회 발행 실패');
  });
});

describe('RecurringRecipesSection — 행 액션(story c7abdf42)', () => {
  it('⭐«지금 한 회차» — POST run-now 호출·응답으로 행 갱신', async () => {
    let runNowCalled = false;
    const updated = { ...ACTIVE_ROW, last_run_at: '2026-09-09T00:00:00Z', next_run_at: '2026-09-16T00:00:00Z' };
    stubFetch({
      [`GET /api/projects/${PROJECT_ID}/repeat-schedules`]: () => ({ ok: true, status: 200, json: async () => ({ data: [ACTIVE_ROW], error: null, meta: null }) }),
      [`POST /api/projects/${PROJECT_ID}/repeat-schedules/${ACTIVE_ROW.id}/run-now`]: () => {
        runNowCalled = true;
        return { ok: true, status: 200, json: async () => ({ data: updated, error: null, meta: null }) };
      },
    });
    await act(async () => { root.render(wrap(<RecurringRecipesSection projectId={PROJECT_ID} />)); });
    await flush();

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.repeatSchedulesRunNowCta);
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(runNowCalled).toBe(true);
    expect(container.textContent).toContain(koMessages.settings.repeatSchedulesRunNowSuccess);
  });

  it('⭐paused 행은 «재개» 버튼만(중지 버튼 없음) — 클릭 시 PATCH resume', async () => {
    let resumeCalled = false;
    stubFetch({
      [`GET /api/projects/${PROJECT_ID}/repeat-schedules`]: () => ({ ok: true, status: 200, json: async () => ({ data: [PAUSED_ROW], error: null, meta: null }) }),
      [`PATCH /api/projects/${PROJECT_ID}/repeat-schedules/${PAUSED_ROW.id}/resume`]: () => {
        resumeCalled = true;
        return { ok: true, status: 200, json: async () => ({ data: { ...PAUSED_ROW, status: 'active', pause_reason: null, consecutive_failure_count: 0 }, error: null, meta: null }) };
      },
    });
    await act(async () => { root.render(wrap(<RecurringRecipesSection projectId={PROJECT_ID} />)); });
    await flush();

    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain(koMessages.settings.repeatSchedulesResumeCta);
    expect(buttons).not.toContain(koMessages.settings.repeatSchedulesPauseCta);

    const resumeBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.repeatSchedulesResumeCta);
    await act(async () => { resumeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(resumeCalled).toBe(true);
    expect(container.textContent).toContain(koMessages.settings.repeatSchedulesResumeSuccess);
    // 재개 후 정지 사유 표시가 사라진다(더 이상 paused가 아니므로).
    expect(container.textContent).not.toContain('연속 3회 발행 실패');
  });

  it('⭐active 행은 «중지» 버튼 — 클릭 시 PATCH pause', async () => {
    let pauseCalled = false;
    stubFetch({
      [`GET /api/projects/${PROJECT_ID}/repeat-schedules`]: () => ({ ok: true, status: 200, json: async () => ({ data: [ACTIVE_ROW], error: null, meta: null }) }),
      [`PATCH /api/projects/${PROJECT_ID}/repeat-schedules/${ACTIVE_ROW.id}/pause`]: () => {
        pauseCalled = true;
        return { ok: true, status: 200, json: async () => ({ data: { ...ACTIVE_ROW, status: 'paused', pause_reason: '수동으로 중지되었습니다' }, error: null, meta: null }) };
      },
    });
    await act(async () => { root.render(wrap(<RecurringRecipesSection projectId={PROJECT_ID} />)); });
    await flush();

    const pauseBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.repeatSchedulesPauseCta);
    await act(async () => { pauseBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(pauseCalled).toBe(true);
    expect(container.textContent).toContain('수동으로 중지되었습니다');
  });

  it('⭐409(동시 tick 경합) — 백엔드 detail 문구가 화면에 그대로 나온다', async () => {
    stubFetch({
      [`GET /api/projects/${PROJECT_ID}/repeat-schedules`]: () => ({ ok: true, status: 200, json: async () => ({ data: [ACTIVE_ROW], error: null, meta: null }) }),
      [`POST /api/projects/${PROJECT_ID}/repeat-schedules/${ACTIVE_ROW.id}/run-now`]: () => ({ ok: false, status: 409, json: async () => ({ detail: '이 스케줄은 지금 다른 회차가 처리 중입니다 — 잠시 후 다시 시도하세요.' }) }),
    });
    await act(async () => { root.render(wrap(<RecurringRecipesSection projectId={PROJECT_ID} />)); });
    await flush();

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.repeatSchedulesRunNowCta);
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toContain('이 스케줄은 지금 다른 회차가 처리 중입니다 — 잠시 후 다시 시도하세요.');
  });
});
