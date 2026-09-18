// @vitest-environment jsdom
//
// story #3316 — organization/events 카탈로그의 신규 "프로젝트에 적용" 다이얼로그. 계약 3개를
// 핀 고정: ①프로젝트 미선택 시 apply 자체가 안 열린다(role_mapping 채울 stage 자체를 못 보여줌)
// ②apply POST body가 gallery와 동형 계약(project_id, role_mapping)을 유지한다 ③warnings[]가
// 있으면 그려지고 없으면 안 그려진다(gallery 회귀수정과 대칭 커버리지).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ApplyRecipeDialog } from './apply-recipe-dialog';
import koMessages from '../../../messages/ko.json';

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const TARGET = {
  id: 'def-1',
  key: 'preset.test.recipe',
  org_id: null,
  name: '테스트 레시피',
  description: '설명',
  payload_schema: { properties: { stage: { enum: ['step_1'] } } },
  stage_metadata: { step_1: { role: 'Developer', action: 'do it' } },
  enabled: true,
};

function stubFetch(applyBody: unknown, capture: { body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: 'Proj One' }] }) };
    if (url.includes('/api/team-members')) {
      return { ok: true, json: async () => ({ data: [{ id: 'agent-1', name: '디디군' }] }) };
    }
    if (url.includes('/api/events/definitions/def-1/bindings')) return { ok: true, json: async () => ({ bindings: {} }) };
    if (url === '/api/events/definitions/def-1/apply') {
      capture.body = init?.body ? JSON.parse(init.body as string) : null;
      return { ok: true, json: async () => applyBody };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

describe('ApplyRecipeDialog', () => {
  it('프로젝트를 고르기 전엔 역할매핑 select가 안 뜬다(고를 프로젝트가 있어야 agent 후보를 안다)', async () => {
    const capture = { body: null as unknown };
    stubFetch({ ok: true, bindings_upserted: 0, warnings: [] }, capture);

    await act(async () => {
      root.render(wrap(
        <ApplyRecipeDialog
          target={TARGET}
          open
          onOpenChange={() => {}}
          t={((k: string) => k) as never}
          tc={((k: string) => k) as never}
          addToast={() => {}}
        />,
      ));
    });
    await flush();

    expect(document.body.querySelectorAll('select').length).toBe(1); // 프로젝트 select만.
  });

  it('apply POST body가 {project_id, role_mapping} 계약을 그대로 지킨다(gallery와 동형 핀)', async () => {
    const capture = { body: null as unknown };
    stubFetch({ ok: true, bindings_upserted: 1, warnings: [] }, capture);

    await act(async () => {
      root.render(wrap(
        <ApplyRecipeDialog
          target={TARGET}
          open
          onOpenChange={() => {}}
          t={((k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k)) as never}
          tc={((k: string) => k) as never}
          addToast={() => {}}
        />,
      ));
    });
    await flush();

    const projectSelect = document.body.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const selects = [...document.body.querySelectorAll('select')];
    const roleSelect = selects[1] as HTMLSelectElement;
    await act(async () => {
      roleSelect.value = 'agent-1';
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'eventApplySubmit');
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(capture.body).toEqual({ project_id: 'proj-1', role_mapping: { step_1: 'agent-1' } });
  });

  // story #3519(§16-7 2부, PO 確定 2026-09-05) — memberRes/bindingsRes 둘 다 부수인데
  // 격리 없이 같은 Promise.all에 있어, 하나가 네트워크단 reject하면 나머지도 조용히
  // 빈 값이 됐다("에이전트 없음"처럼 보이지만 실은 네트워크 실패).
  it('/api/team-members가 네트워크 reject해도 bindings(다른 leg)는 그대로 반영된다', async () => {
    const capture = { body: null as unknown };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: 'Proj One' }] }) };
      if (url.includes('/api/team-members')) throw new Error('network down');
      if (url.includes('/api/events/definitions/def-1/bindings')) {
        return { ok: true, json: async () => ({ bindings: { step_1: 'agent-prebound' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <ApplyRecipeDialog
          target={TARGET}
          open
          onOpenChange={() => {}}
          t={((k: string) => k) as never}
          tc={((k: string) => k) as never}
          addToast={() => {}}
        />,
      ));
    });
    await flush();

    const projectSelect = document.body.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    // bindings leg가 살아서 role_mapping을 미리 채운다(step_1='agent-prebound') — 그
    // 결과 제출 버튼이 "역할 미지정" 사유로 막히지 않는다. memberRes가 reject해도
    // agents=[]로 조용히 degrade할 뿐, bindings 값 자체(별개 leg)는 사라지면 안 된다.
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'eventApplySubmit') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    void capture;
    // story #3521(유나 §22-2) — "응답 없음"(네트워크 reject) 갈래는 못 불러옴 얼굴이 뜨고
    // "에이전트 없음"은 안 뜬다(진짜 0명이 아니므로 그 문구는 오귀인).
    expect(document.body.querySelector('[data-testid="apply-recipe-agents-load-error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="apply-recipe-agents-empty"]')).toBeNull();
  });

  // story #3521 — "응답 실패"(non-ok status)도 "응답 없음"(위 테스트, network reject)과
  // 동형으로 못 불러옴 얼굴을 낸다.
  it('/api/team-members가 403이면(응답은 왔지만 실패) "에이전트 목록을 불러오지 못했습니다" 얼굴이 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: 'Proj One' }] }) };
      if (url.includes('/api/team-members')) return { ok: false, status: 403, json: async () => ({ detail: 'forbidden' }) };
      if (url.includes('/api/events/definitions/def-1/bindings')) return { ok: true, json: async () => ({ bindings: {} }) };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <ApplyRecipeDialog
          target={TARGET} open onOpenChange={() => {}}
          t={((k: string) => k) as never} tc={((k: string) => k) as never} addToast={() => {}}
        />,
      ));
    });
    await flush();
    const projectSelect = document.body.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(document.body.textContent).toContain('eventApplyAgentsLoadError');
  });

  // story #3521 — 진짜 0명(둘 다 성공, 에이전트 배열만 빈 경우)은 "에이전트 없음"이지
  // "불러오지 못했습니다"가 아니다 — 두 얼굴이 절대 안 섞여야 한다.
  it('team-members가 200+빈 배열이면(진짜 0명) "이 프로젝트에 에이전트가 없습니다"만 뜨고 실패 얼굴은 안 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: 'Proj One' }] }) };
      if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/events/definitions/def-1/bindings')) return { ok: true, json: async () => ({ bindings: {} }) };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <ApplyRecipeDialog
          target={TARGET} open onOpenChange={() => {}}
          t={((k: string) => k) as never} tc={((k: string) => k) as never} addToast={() => {}}
        />,
      ));
    });
    await flush();
    const projectSelect = document.body.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="apply-recipe-agents-empty"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="apply-recipe-agents-load-error"]')).toBeNull();
  });

  // story #3521 — 「다시 시도」가 실제로 재조회한다.
  it('에이전트 로드 실패 후 「다시 시도」 클릭 — 재조회 성공 시 에이전트 목록이 채워진다', async () => {
    let teamMembersShouldFail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: 'Proj One' }] }) };
      if (url.includes('/api/team-members')) {
        if (teamMembersShouldFail) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: [{ id: 'agent-1', name: '디디군' }] }) };
      }
      if (url.includes('/api/events/definitions/def-1/bindings')) return { ok: true, json: async () => ({ bindings: {} }) };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <ApplyRecipeDialog
          target={TARGET} open onOpenChange={() => {}}
          t={((k: string) => k) as never} tc={((k: string) => k) as never} addToast={() => {}}
        />,
      ));
    });
    await flush();
    const projectSelect = document.body.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(document.body.querySelector('[data-testid="apply-recipe-agents-load-error"]')).not.toBeNull();

    teamMembersShouldFail = false;
    const retryBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'eventApplyAgentsRetry') as HTMLButtonElement;
    await act(async () => { retryBtn.click(); });
    await flush();

    expect(document.body.querySelector('[data-testid="apply-recipe-agents-load-error"]')).toBeNull();
    const roleSelect = [...document.body.querySelectorAll('select')][1] as HTMLSelectElement;
    expect(roleSelect.textContent).toContain('디디군');
  });

  it('apply 응답에 warnings가 있으면 그려진다', async () => {
    const capture = { body: null as unknown };
    stubFetch({ ok: true, bindings_upserted: 1, warnings: ['capability.connector_key 미해소 — org에 매칭되는 커넥터 여러 개'] }, capture);

    await act(async () => {
      root.render(wrap(
        <ApplyRecipeDialog
          target={TARGET}
          open
          onOpenChange={() => {}}
          t={((k: string) => k) as never}
          tc={((k: string) => k) as never}
          addToast={() => {}}
        />,
      ));
    });
    await flush();

    const projectSelect = document.body.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const roleSelect = [...document.body.querySelectorAll('select')][1] as HTMLSelectElement;
    await act(async () => {
      roleSelect.value = 'agent-1';
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'eventApplySubmit');
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(document.body.textContent).toContain('capability.connector_key 미해소 — org에 매칭되는 커넥터 여러 개');
  });
});
