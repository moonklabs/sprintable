// @vitest-environment jsdom
//
// story #2534(E-FLOW-V4 S4) — 미매달림 버킷. 지구 지도와 분리(별도 접힘 서랍)·현재
// 카운트는 BE X-Total-Count(카디르 QA HIGH fix — stories.length가 아니라 정확한 전체
// 총계)·자동제안 칩 클릭 한 번으로 매달기(폼 없음)·매단 뒤 버킷에서 즉시 사라짐(용어
// 정정 — 「낙관적」이 아니라 success-gated: 200 응답 확認 後에만 제거)을 값으로 잰다.
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

// 카디르 QA HIGH(2026-08-09) — /api/stories?unattached=true 실 응답은 meta.total(BE
// X-Total-Count 헤더 값)을 함께 낸다(route.ts 실물 반영). 카운트 테스트는 이 형태를 그대로
// 재현해야 stories.length로 조용히 되돌아가는 회귀를 잡는다.
function jsonResWithTotal(data: unknown[], total: number) {
  return Promise.resolve(new Response(JSON.stringify({ data, meta: { total } }), { status: 200 }));
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
  it('?unattached=true로 조회해 카운트를 서랍 요약에 보인다(meta.total 기준)', async () => {
    await renderBucket(routedFetch([
      ['/api/stories?project_id=p1&unattached=true', () => jsonResWithTotal([
        { id: 's1', title: '미매달림 작업1' },
        { id: 's2', title: '미매달림 작업2' },
      ], 2)],
    ]));

    const summary = container.querySelector('summary');
    expect(summary?.textContent).toContain(koMessages.flow.bucketHeading.replace('{n}', '2'));
  });

  it('카디르 QA HIGH fix — 카운트는 meta.total(정확한 전체)이지 stories.length(페이지 길이)가 아니다', async () => {
    // 실사례 재현: limit=100에 걸려 페이지엔 1건만 오지만, 실제 미매달림 총계는 2180건.
    await renderBucket(routedFetch([
      ['/api/stories?project_id=p1&unattached=true', () => jsonResWithTotal([
        { id: 's1', title: '미매달림 작업1' },
      ], 2180)],
    ]));

    const summary = container.querySelector('summary');
    expect(summary?.textContent).toContain(koMessages.flow.bucketHeading.replace('{n}', '2180'));
    expect(summary?.textContent).not.toContain(koMessages.flow.bucketHeading.replace('{n}', '1'));
  });

  it('meta.total이 없으면(예외 상황) stories.length로 안전 폴백한다', async () => {
    await renderBucket(routedFetch([
      ['/api/stories?project_id=p1&unattached=true', [{ id: 's1', title: '작업A' }]],
    ]));

    const summary = container.querySelector('summary');
    expect(summary?.textContent).toContain(koMessages.flow.bucketHeading.replace('{n}', '1'));
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
    // 매단 작업은 더 이상 미매달림이 아니므로 버킷에서 사라진다(success-gated 제거 —
    // res.ok 확認 後에만 지운다, 낙관적 아님).
    expect(container.textContent).toContain(koMessages.flow.bucketEmpty);
  });

  it('카디르 QA MEDIUM fix — 매달기 실패(non-2xx)시 에러 문구를 보이고 버킷에서 안 지운다', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/stories?project_id=p1&unattached=true') && (!init || init.method === undefined)) {
        return jsonResWithTotal([{ id: 's1', title: '작업A' }], 1);
      }
      if (url === '/api/stories/s1/attachment-suggestions') {
        return rawRes({ suggested_type: 'goal', goal_candidates: [{ id: 'g1', text: '목표 후보', score: 3 }], hypothesis_candidates: [] });
      }
      if (url === '/api/stories/s1' && init?.method === 'PATCH') {
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'nope' } }), { status: 403 }));
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
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain(koMessages.flow.bucketAttachError);
    // 실패했으니 버킷에서 안 지워지고 그대로 남는다(success-gated).
    expect(container.textContent).not.toContain(koMessages.flow.bucketEmpty);
    expect(container.textContent).toContain('작업A');
  });

  it('카디르 QA MEDIUM fix(3차, 2026-08-09) — 페이지(limit=100)에 로드된 것만 다 매달아도 total이 남으면 빈 상태를 안 보인다(요약줄과 본문 정직성 불일치 방지)', async () => {
    // 실사례 재현: total=2(limit보다 훨씬 작은 값으로도 같은 결함 재현 가능)인데
    // 페이지에 로드된 1건을 매달면 stories.length는 0이 되지만 total은 1로 남는다 —
    // 요약줄 "1"과 본문 "미매달림 없습니다"가 동시에 뜨면 안 된다(unattached-bucket.tsx:234
    // 는 원래 stories.length===0을 봐서 이 모순이 났다).
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/stories?project_id=p1&unattached=true') && (!init || init.method === undefined)) {
        return jsonResWithTotal([{ id: 's1', title: '작업A' }], 2);
      }
      if (url === '/api/stories/s1/attachment-suggestions') {
        return rawRes({ suggested_type: 'goal', goal_candidates: [{ id: 'g1', text: '목표 후보', score: 3 }], hypothesis_candidates: [] });
      }
      if (url === '/api/stories/s1' && init?.method === 'PATCH') {
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
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const summary = container.querySelector('summary');
    expect(summary?.textContent).toContain(koMessages.flow.bucketHeading.replace('{n}', '1'));
    // total이 1로 남아있으니(페이지 밖에 더 있다) 빈 상태 문구가 뜨면 모순이다.
    expect(container.textContent).not.toContain(koMessages.flow.bucketEmpty);
  });

  it('total이 실제로 0이 되면(마지막 1건을 매달아 소진) 빈 상태를 정직하게 보인다', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/stories?project_id=p1&unattached=true') && (!init || init.method === undefined)) {
        return jsonResWithTotal([{ id: 's1', title: '작업A' }], 1);
      }
      if (url === '/api/stories/s1/attachment-suggestions') {
        return rawRes({ suggested_type: 'goal', goal_candidates: [{ id: 'g1', text: '목표 후보', score: 3 }], hypothesis_candidates: [] });
      }
      if (url === '/api/stories/s1' && init?.method === 'PATCH') {
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
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

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
