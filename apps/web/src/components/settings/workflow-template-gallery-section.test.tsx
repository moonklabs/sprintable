// @vitest-environment jsdom
//
// story #3293(도메인탈고정 축2-ⓒ) — 구세대 workflow_templates 소비를 신세대
// (EventDefinition/recipe_role_bindings, 축2-ⓐ story #3288) 이전에 맞춰 전면 재작성.
// story #2501(error.message 분기)·#3010(elev-card 토큰) 회귀가드는 새 fetch 표면
// (/api/events/definitions 계열)에 맞춰 그대로 보존.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { WorkflowTemplateGallerySection } from './workflow-template-gallery-section';
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

const DEFINITION = {
  id: 'def-1',
  key: 'preset.test.recipe',
  org_id: null,
  name: '테스트 레시피',
  description: '설명',
  payload_schema: { properties: { stage: { enum: ['step_1'] } } },
  stage_metadata: {},
  enabled: true,
};

function stubFetch(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/events/definitions' && !init) return { ok: true, json: async () => [DEFINITION] };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/events/definitions/def-1/bindings')) {
      // step_1이 이미 배정돼 있어야 requiredStages 검증(빈 매핑 차단)을 통과하고
      // 실제 apply fetch까지 도달한다 — 이 describe 블록의 관심사는 apply 실패
      // 응답 렌더링이지 역할매핑 완결성 검증이 아니므로 최소 fixture로 그 표면만 자른다.
      return { ok: true, json: async () => ({ bindings: { step_1: 'agent-1' } }) };
    }
    if (url === '/api/events/definitions/def-1/apply' && overrides['apply']) {
      return overrides['apply'];
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

// story #3519(§16-7 2부, PO 確定 2026-09-05) — defRes(주, 갤러리 몸통)와 memberRes
// (부수)가 미격리 Promise.all에 있어, memberRes가 네트워크단 reject하면 defRes도
// 조용히 못 채워져 갤러리가 거짓 "항목 없음"으로 보이던 결함의 회귀가드.
describe('WorkflowTemplateGallerySection — Promise.all 부수 격리(story #3519)', () => {
  it('/api/team-members가 네트워크 reject해도 정의 목록(주 데이터)은 그대로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions' && !init) return { ok: true, json: async () => [DEFINITION] };
      if (url.includes('/api/team-members')) throw new Error('network down');
      if (url.includes('/api/events/definitions/def-1/bindings')) return { ok: true, json: async () => ({ bindings: {} }) };
      return { ok: false, json: async () => null };
    }));
    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();
    expect(container.textContent).toContain('테스트 레시피');
  });
});

describe('WorkflowTemplateGallerySection — error.message 분기 (story #2501 계승)', () => {
  it('적용 실패 사유가 raw "적용 실패" 폴백 대신 실 서버 메시지로 뜬다(핵심 회귀가드)', async () => {
    stubFetch({
      apply: {
        ok: false,
        json: async () => ({
          data: null,
          error: { code: 'UNPROCESSABLE_ENTITY', message: 'agent(s) not found in this org: abc' },
          meta: null,
        }),
      },
    });

    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 레시피'));
    await act(async () => { tmplBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '재적용(덮어쓰기)');
    expect(applyBtn).not.toBeUndefined();
    await act(async () => { applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('적용 실패');
    expect(container.textContent).toContain('agent(s) not found in this org: abc');
  });

  it('backend가 error.message를 안 주면(네트워크 계층 등) 안전 폴백 "적용 실패"로 간다(회귀 없음)', async () => {
    stubFetch({
      apply: { ok: false, json: async () => ({ data: null, error: {}, meta: null }) },
    });

    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 레시피'));
    await act(async () => { tmplBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '재적용(덮어쓰기)');
    await act(async () => { applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toContain('적용 실패');
  });
});

// story #3010(로드맵 P3, L1) — 선택 가능한 템플릿 카드는 인라인 카드라 --elev-card.
describe('WorkflowTemplateGallerySection — 로드맵 P3 L1(템플릿 카드 elevation 토큰)', () => {
  it('템플릿 카드가 hover:shadow-[var(--elev-card)]를 쓰고 hover:shadow-sm은 안 쓴다', async () => {
    stubFetch();
    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 레시피'));
    expect(tmplBtn).not.toBeUndefined();
    expect(tmplBtn?.className).toContain('hover:shadow-[var(--elev-card)]');
    expect(tmplBtn?.className).not.toMatch(/hover:shadow-sm(\s|$)/);
  });
});

// story #3293(축2-ⓒ) 신규 — PO 확定 A: overwrite 확認 다이얼로그 없이 기존 배정값 프리필.
describe('WorkflowTemplateGallerySection — 축2-ⓒ 프리필(PO 확定 A)', () => {
  it('기존 배정이 있으면 확認 다이얼로그 없이 드롭다운에 프리필된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions' && !init) {
        return { ok: true, json: async () => [{ ...DEFINITION, stage_metadata: { step_1: { role: 'Developer', action: 'do it' } } }] };
      }
      if (url.includes('/api/team-members')) {
        return { ok: true, json: async () => ({ data: [{ id: 'agent-1', name: '디디군', type: 'agent' }] }) };
      }
      if (url.includes('/api/events/definitions/def-1/bindings')) {
        return { ok: true, json: async () => ({ bindings: { step_1: 'agent-1' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    // "적용됨" 배지가 이미 떠 있어야 한다(bindings 비어있지 않음).
    expect(container.textContent).toContain('적용됨');

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 레시피'));
    await act(async () => { tmplBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    // 확認 다이얼로그 텍스트가 없어야 한다(PO 확定 A — 다이얼로그 자체를 없앰).
    expect(container.textContent).not.toContain('교체됩니다');
    // 대신 select가 기존 배정값으로 프리필돼 있어야 한다.
    const select = container.querySelector('select');
    expect(select?.value).toBe('agent-1');
    // 버튼 라벨도 "재적용" 문구로 이미 적용됨을 알린다.
    expect(container.textContent).toContain('재적용');
  });
});

// story #3316 — apply 응답 warnings[]가 지금까지 이 갤러리에서 destructure조차 안 돼(응답 필드
// 자체가 빠짐) 조용히 버려지고 있었다(회귀 없음 확인 + 재발 방지 핀).
describe('WorkflowTemplateGallerySection — apply warnings[] 렌더(story #3316 회귀수정)', () => {
  it('apply 응답에 warnings가 있으면 화면에 그려진다', async () => {
    stubFetch({
      // story #3288 route.ts — /apply는 apiSuccess로 감싸지 않는 raw proxyToFastapi 그대로라
      // 응답 필드(ok/bindings_upserted/warnings)가 top-level에 온다(위 실패 케이스 fixture의
      // data:null은 죽은 키 — 컴포넌트가 안 읽음. 여기선 애초에 안 넣어 그 함정을 반복 안 함).
      apply: {
        ok: true,
        json: async () => ({ ok: true, bindings_upserted: 1, warnings: ['connector "slack" 미해소 — 수동 확인 필요'] }),
      },
    });

    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 레시피'));
    await act(async () => { tmplBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '재적용(덮어쓰기)');
    await act(async () => { applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toContain('connector "slack" 미해소 — 수동 확인 필요');
  });

  it('apply 응답에 warnings가 없으면(정상 케이스) 주의 블록 자체가 안 그려진다', async () => {
    stubFetch({
      apply: {
        ok: true,
        json: async () => ({ ok: true, bindings_upserted: 1, warnings: [] }),
      },
    });

    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 레시피'));
    await act(async () => { tmplBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '재적용(덮어쓰기)');
    await act(async () => { applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('주의');
  });
});
