// @vitest-environment jsdom
//
// story #2792(2790 P1) — LoopCreateDialog가 GET /api/events/definitions 카탈로그에서
// 사이클형만 골라 select에 렌더하고, 제출 시 recipe_slug 필드(이름 유지)에 선택된 정의의
// key 값을 담는지 실마운트로 확인한다. [[feedback-render-test-over-source-grep]] 동형 —
// 소스만 보고 "filter 잘 됐다"고 서술하는 대신 실제 DOM/제출 payload로 확인.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LoopCreateDialog } from './loop-create-dialog';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFINITIONS = [
  {
    id: '1', key: 'preset.workflow.scrum_3step', org_id: null,
    name: '3단계 스크럼', description: '기획 → 개발 → QA 3단계 워크플로우.',
    payload_schema: { properties: { stage: { enum: ['kickoff', 'implementation', 'qa_review'] } } },
    stage_metadata: {
      kickoff: { role: 'PO', action: '기능 명세 및 AC 작성' },
      implementation: { role: 'Dev', action: '코드 작성 및 PR 제출' },
      qa_review: { role: 'QA', action: 'AC 체크리스트 검증 후 APPROVE/REJECT' },
    },
    enabled: true,
  },
  {
    id: '2', key: 'org.acme.deploy_started', org_id: 'org-acme',
    name: '배포 시작(비-사이클형)', description: null,
    payload_schema: { properties: {} },
    stage_metadata: {},
    enabled: true,
  },
  // 까디르군 QA(#3238) — GET /api/events/definitions는 admin 감사 목적으로 disabled도
  // 의도적으로 내려준다. 구 /api/workflow-recipes는 활성만 반환했으므로 안 거르면 실회귀.
  {
    id: '3', key: 'org.acme.custom_flow', org_id: 'org-acme',
    name: '커스텀 흐름(비활성 — 드롭다운에 안 뜨는 게 정상)', description: null,
    payload_schema: { properties: { stage: { enum: ['draft', 'review'] } } },
    stage_metadata: { draft: { role: 'Dev', action: '초안 작성' }, review: { role: 'PO', action: '검토' } },
    enabled: false,
  },
];

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

describe('LoopCreateDialog 레시피 선택 (story #2792 — event_definitions 전환)', () => {
  it('GET /api/events/definitions 카탈로그에서 사이클형만 select 옵션으로 걸러 렌더한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => DEFINITIONS };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(<LoopCreateDialog projectId="proj-1" open onOpenChange={() => {}} onCreated={() => {}} />));
    });
    await flush();

    const options = Array.from(document.body.querySelectorAll('#loop-create-recipe option')).map((o) => o.textContent);
    expect(options).toContain('3단계 스크럼');
    expect(options).not.toContain('배포 시작(비-사이클형)');
    // 까디르군 QA(#3238) — disabled 사이클형 정의는 stage가 있어도 드롭다운에 뜨면 안 된다.
    expect(options).not.toContain('커스텀 흐름(비활성 — 드롭다운에 안 뜨는 게 정상)');
  });

  it('레시피 선택 시 stage_metadata의 action(role)을 순서대로 보여준다(짧은 label 없이도 정직 표시)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => DEFINITIONS };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(<LoopCreateDialog projectId="proj-1" open onOpenChange={() => {}} onCreated={() => {}} />));
    });
    await flush();

    const select = document.body.querySelector('#loop-create-recipe') as HTMLSelectElement;
    await act(async () => {
      select.value = 'preset.workflow.scrum_3step';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(document.body.textContent).toContain('기능 명세 및 AC 작성');
    expect(document.body.textContent).toContain('PO');
    expect(document.body.textContent).toContain('AC 체크리스트 검증 후 APPROVE/REJECT');
  });

  it('제출 시 recipe_slug 필드에 선택된 정의의 key 값을 싣는다(필드명 유지, 값만 신규 key)', async () => {
    let submittedBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => DEFINITIONS };
      if (url === '/api/loops' && init?.method === 'POST') {
        submittedBody = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({ id: 'loop-1' }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(<LoopCreateDialog projectId="proj-1" open onOpenChange={() => {}} onCreated={() => {}} />));
    });
    await flush();

    function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const select = document.body.querySelector('#loop-create-recipe') as HTMLSelectElement;
    await act(async () => {
      select.value = 'preset.workflow.scrum_3step';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const titleInput = document.body.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(titleInput, '테스트 루프'); });
    const statementTextarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { setNativeValue(statementTextarea, '가설 문장'); });
    const inputs = Array.from(document.body.querySelectorAll('input'));
    const metricInput = inputs[1] as HTMLInputElement;
    await act(async () => { setNativeValue(metricInput, 'conversion_rate'); });
    const dateInput = document.body.querySelector('input[type="date"]') as HTMLInputElement;
    await act(async () => { setNativeValue(dateInput, '2026-09-01'); });

    const submitBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.loops.createLoopSubmit);
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(submittedBody).not.toBeNull();
    expect(submittedBody!['recipe_slug']).toBe('preset.workflow.scrum_3step');
  });
});
