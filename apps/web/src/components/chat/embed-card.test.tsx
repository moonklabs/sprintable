// @vitest-environment jsdom
//
// story #2168 PR-① — 채팅에 임베드된 doc이 "현재 프로젝트"와 다른 project 소속일 때 못 열리던
// 원 결함(조사 로그: embed-card.tsx의 handleDocClick이 project 없는 bare `/docs/{slug}/view`로
// 이동 → middleware가 CURRENT_PROJECT_COOKIE로 project를 추측 → 다른 project 문서면 못 찾음).
// 처방 = /api/docs/preview 가 이제 내려주는 doc 자신의 project(orgSlug/projectSlug)로 직행.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmbedCard } from './embed-card';

const pushMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

let container: HTMLDivElement;
let root: Root;

function stubFetch(impl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn((url: string) => impl(url)));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function clickMainDocButton() {
  const btn = container.querySelector('button');
  await act(async () => {
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('EmbedCard doc — story #2168 PR-①', () => {
  it('크로스프로젝트 doc(다른 project 소속)을 클릭하면 그 project 경로로 직행한다', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        data: { slug: 'other-doc', orgSlug: 'acme', projectSlug: 'content', projectId: 'p-2' },
      }),
    }));
    await act(async () => {
      root.render(<EmbedCard entity_type="doc" entity_id="doc-1" title="T" status={null} />);
    });
    await clickMainDocButton();
    expect(pushMock).toHaveBeenCalledWith('/acme/content/docs/other-doc/view');
  });

  it('project_slug 가 없으면(옛 미백필 프로젝트) bare 링크로 우아하게 폴백한다(회귀 아님)', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        data: { slug: 'legacy-doc', orgSlug: 'acme', projectSlug: null, projectId: 'p-3' },
      }),
    }));
    await act(async () => {
      root.render(<EmbedCard entity_type="doc" entity_id="doc-2" title="T" status={null} />);
    });
    await clickMainDocButton();
    expect(pushMock).toHaveBeenCalledWith('/docs/legacy-doc/view');
  });

  it('preview fetch 실패 시 이동하지 않고 navigating 스피너를 해제한다', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(<EmbedCard entity_type="doc" entity_id="doc-3" title="T" status={null} />);
    });
    await clickMainDocButton();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
