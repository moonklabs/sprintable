// @vitest-environment jsdom
//
// story #2534(E-FLOW-V4 S4) — 미매달림 버킷. 지구 지도와 분리(별도 접힘 서랍)·현재
// 카운트만(추세 주장 없음, BE에 시계열 데이터가 없어서)·자동제안 칩 클릭 한 번으로
// 매달기(폼 없음)·매단 뒤 버킷에서 즉시 사라짐(재조회 없이 낙관적 제거)을 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { UnattachedBucket } from './unattached-bucket';

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

async function renderBucket(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  await act(async () => {
    root.render(wrap(<UnattachedBucket projectId="p1" />));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function jsonRes(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
}

// attachment-suggestions는 reference-candidates와 동형 raw thin-proxy(래핑 없음) —
// {data} 봉투를 안 씌운다(다른 라우트와 형상이 다름, 실제 route.ts 그대로 반영).
function rawRes(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
}

function routedFetch(routes: Array<[string, unknown]>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    for (const [key, data] of routes) {
      const [routeMethod, routePrefix] = key.includes(' ') ? key.split(' ') as [string, string] : ['GET', key];
      if (method === routeMethod && url.startsWith(routePrefix)) {
        if (typeof data === 'function') return (data as () => Promise<Response>)();
        return routePrefix.includes('attachment-suggestions') ? rawRes(data) : jsonRes(data);
      }
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

describe('UnattachedBucket — story #2534', () => {
  it('?unattached=true로 조회해 카운트를 서랍 요약에 보인다(추세 없이 현재 숫자만)', async () => {
    await renderBucket(routedFetch([
      ['/api/stories?project_id=p1&unattached=true', [
        { id: 's1', title: '미매달림 작업1' },
        { id: 's2', title: '미매달림 작업2' },
      ]],
    ]));

    const summary = container.querySelector('summary');
    expect(summary?.textContent).toContain(koMessages.flow.bucketHeading.replace('{n}', '2'));
  });

  it('빈 버킷은 정직한 빈 상태를 보인다(더미 없음)', async () => {
    await renderBucket(routedFetch([
      ['/api/stories?project_id=p1&unattached=true', []],
    ]));

    expect(container.textContent).toContain(koMessages.flow.bucketEmpty);
  });

  it('로드 실패시 에러 문구를 보이고 크래시하지 않는다', async () => {
    await renderBucket(vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))));
    expect(container.textContent).toContain(koMessages.flow.bucketLoadError);
  });

  it('"제안 보기"를 누르면 attachment-suggestions를 지연 호출하고 후보 칩을 보인다', async () => {
    const fetchMock = routedFetch([
      ['/api/stories?project_id=p1&unattached=true', [{ id: 's1', title: '작업A' }]],
      ['/api/stories/s1/attachment-suggestions', {
        suggested_type: 'goal',
        goal_candidates: [{ id: 'g1', text: '목표 후보', score: 3 }],
        hypothesis_candidates: [],
      }],
    ]);
    await renderBucket(fetchMock);

    const showButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.flow.bucketShowSuggestion);
    expect(showButton).toBeTruthy();
    await act(async () => {
      showButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('목표 후보');
  });

  it('목표 후보 칩을 클릭하면 PATCH /api/stories/{id} {epic_id}로 매달고, 버킷에서 즉시 사라진다', async () => {
    const patchCalls: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/stories?project_id=p1&unattached=true') && (!init || init.method === undefined)) {
        return jsonRes([{ id: 's1', title: '작업A' }]);
      }
      if (url === '/api/stories/s1/attachment-suggestions') {
        return rawRes({ suggested_type: 'goal', goal_candidates: [{ id: 'g1', text: '목표 후보', score: 3 }], hypothesis_candidates: [] });
      }
      if (url === '/api/stories/s1' && init?.method === 'PATCH') {
        patchCalls.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify({ data: { id: 's1' } }), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    await renderBucket(fetchMock);

    const showButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.flow.bucketShowSuggestion);
    await act(async () => {
      showButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const chip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('목표 후보'));
    expect(chip).toBeTruthy();
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(patchCalls).toEqual([{ epic_id: 'g1' }]);
    // 매단 작업은 더 이상 미매달림이 아니므로 버킷에서 사라진다(낙관적 제거).
    expect(container.textContent).toContain(koMessages.flow.bucketEmpty);
  });

  it('가설 후보 칩을 클릭하면 POST /api/hypotheses/{id}/links {story_ids,link_type}로 매단다', async () => {
    const linkCalls: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/stories?project_id=p1&unattached=true') && !init?.method) {
        return jsonRes([{ id: 's1', title: '작업A' }]);
      }
      if (url === '/api/stories/s1/attachment-suggestions') {
        return rawRes({ suggested_type: 'hypothesis', goal_candidates: [], hypothesis_candidates: [{ id: 'h1', text: '가설 후보', score: 2 }] });
      }
      if (url === '/api/hypotheses/h1/links' && init?.method === 'POST') {
        linkCalls.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify({ data: { id: 'h1' } }), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    await renderBucket(fetchMock);

    const showButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.flow.bucketShowSuggestion);
    await act(async () => {
      showButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const chip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('가설 후보'));
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(linkCalls).toEqual([{ story_ids: ['s1'], link_type: 'supports' }]);
  });

  it('후보가 없으면 정직하게 "제안할 후보가 없습니다"를 보인다(지어내지 않는다)', async () => {
    await renderBucket(routedFetch([
      ['/api/stories?project_id=p1&unattached=true', [{ id: 's1', title: '작업A' }]],
      ['/api/stories/s1/attachment-suggestions', { suggested_type: 'ambiguous', goal_candidates: [], hypothesis_candidates: [] }],
    ]));

    const showButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.flow.bucketShowSuggestion);
    await act(async () => {
      showButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain(koMessages.flow.bucketNoSuggestion);
  });
});
