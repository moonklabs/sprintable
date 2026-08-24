// @vitest-environment jsdom
//
// story #2501 — `data.detail`은 실 envelope({data,error,meta})에 없는 필드라 이 분기는
// 항상 죽어있었다(그라운딩 확認 — backend apply_template()은 generic HTTP상태 코드만
// 낸다) — 적용 실패 사유가 한 번도 화면에 안 뜨고 항상 '적용 실패'만 보여줬다.
// `error.message`로 교정한 회귀가드.

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

// role_ref가 있는 step이 하나도 없어 requiredSteps가 비고, "적용하기" 버튼이 role
// 매핑 없이 바로 활성화된다 — 이 테스트가 검증하려는 건 apply 실패 응답 처리이지
// 역할매핑 UI가 아니므로 최소 fixture로 그 표면만 자른다.
const TEMPLATE = {
  slug: 'tmpl-1',
  name: '테스트 템플릿',
  description: '설명',
  chain_length: 1,
  steps: [],
  presets: {},
  rules_template: [],
  is_system: true,
};

describe('WorkflowTemplateGallerySection — error.code 분기 (story #2501)', () => {
  it('적용 실패 사유가 raw "적용 실패" 폴백 대신 실 서버 메시지로 뜬다(핵심 회귀가드)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/workflow-templates' && !init) return { ok: true, json: async () => [TEMPLATE] };
      if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/v1/agent-routing-rules')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/workflow-templates/tmpl-1' && (!init || init.method === undefined)) {
        return { ok: true, json: async () => TEMPLATE };
      }
      if (url === '/api/workflow-templates/tmpl-1/apply') {
        return {
          ok: false,
          json: async () => ({
            data: null,
            error: { code: 'UNPROCESSABLE_ENTITY', message: 'agent(s) not found in this org: abc' },
            meta: null,
          }),
        };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 템플릿'));
    await act(async () => { tmplBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '적용하기');
    expect(applyBtn).not.toBeUndefined();
    await act(async () => { applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('적용 실패');
    expect(container.textContent).toContain('agent(s) not found in this org: abc');
  });

  it('backend가 error.message를 안 주면(네트워크 계층 등) 안전 폴백 "적용 실패"로 간다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/workflow-templates' && !init) return { ok: true, json: async () => [TEMPLATE] };
      if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/v1/agent-routing-rules')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/workflow-templates/tmpl-1' && (!init || init.method === undefined)) {
        return { ok: true, json: async () => TEMPLATE };
      }
      if (url === '/api/workflow-templates/tmpl-1/apply') {
        return { ok: false, json: async () => ({ data: null, error: {}, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 템플릿'));
    await act(async () => { tmplBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '적용하기');
    await act(async () => { applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toContain('적용 실패');
  });
});

// story #3010(로드맵 P3, L1) — 선택 가능한 템플릿 카드는 인라인 카드라 --elev-card.
describe('WorkflowTemplateGallerySection — 로드맵 P3 L1(템플릿 카드 elevation 토큰)', () => {
  it('템플릿 카드가 hover:shadow-[var(--elev-card)]를 쓰고 hover:shadow-sm은 안 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/workflow-templates' && !init) return { ok: true, json: async () => [TEMPLATE] };
      if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/v1/agent-routing-rules')) return { ok: true, json: async () => ({ data: [] }) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<WorkflowTemplateGallerySection projectId="proj-1" />)); });
    await flush();

    const tmplBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('테스트 템플릿'));
    expect(tmplBtn).not.toBeUndefined();
    expect(tmplBtn?.className).toContain('hover:shadow-[var(--elev-card)]');
    expect(tmplBtn?.className).not.toMatch(/hover:shadow-sm(\s|$)/);
  });
});
