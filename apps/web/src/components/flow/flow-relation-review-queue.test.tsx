// @vitest-environment jsdom
//
// story #2358 — 「확認하기」 훑기 큐 전체 왕복을 값으로 닫는다. doc `flow-port-slot-spec`
// §㉥ 판정선 그대로: ①「3/17」처럼 진행이 보이는가 ②「나중에」는 그것만 건너뛰고 다음으로
// 가는가(서버 호출 없이) ③다 훑으면 「N건 확認함」이 남는가 ④일괄 확定 버튼이 없는가(#2269).
// Dialog는 document.body에 포탈되므로(#2354 교훈 그대로) document에서 찾는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowRelationReviewQueue } from './flow-relation-review-queue';
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

const CANDIDATES = [
  { id: 'c1', source_id: 's1', target_id: 't1', relation_kind: null, status: 'estimated' },
  { id: 'c2', source_id: 's1', target_id: 't2', relation_kind: null, status: 'estimated' },
];
const STORIES = [
  { id: 't1', story_number: 101, title: 'Target One' },
  { id: 't2', story_number: 102, title: 'Target Two' },
];

function stubFetch(calls: Array<{ url: string; init?: RequestInit }>, overrides: Record<string, () => { ok: boolean; json: () => Promise<unknown> }> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler();
    }
    if (url === '/api/stories/s1/reference-candidates') {
      return { ok: true, json: async () => CANDIDATES };
    }
    if (url.startsWith('/api/stories?ids=')) {
      return { ok: true, json: async () => ({ data: STORIES }) };
    }
    if (url.includes('/declare') || url.includes('/relation-kind') || url.includes('/reject')) {
      return { ok: true, json: async () => ({ id: 'x' }) };
    }
    return { ok: false, json: async () => null };
  }));
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

async function renderQueue(onClose = () => {}, onCandidateResolved?: () => void) {
  await act(async () => {
    root.render(wrap(
      <FlowRelationReviewQueue storyId="s1" storyNumber={1} onClose={onClose} onCandidateResolved={onCandidateResolved} />,
    ));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('FlowRelationReviewQueue — 진행 표시 및 되읽기 문장(§㉥)', () => {
  it('shows the pair sentence, progress, and the question — no bulk-confirm button anywhere (#2269)', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls);
    await renderQueue();

    expect(document.body.textContent).toContain('#1에서 #101로 잇습니다');
    expect(document.body.textContent).toContain('1 / 2');
    expect(document.body.textContent).toContain('이 둘은 어떤 관계입니까?');
    // 일괄 확定 버튼 금지 — "전부" 류 문구가 어디에도 없어야 한다.
    expect(document.body.textContent).not.toContain('전부');
  });
});

describe('FlowRelationReviewQueue — 답하면 다음 후보가 같은 자리에 바로 온다(왕복 1)', () => {
  it('declaring with a kind calls declare then relation-kind, then advances to the next candidate', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch(calls);
    const onCandidateResolved = vi.fn();
    await renderQueue(() => {}, onCandidateResolved);

    const spawnedButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '여기서 나온 일');
    await act(async () => {
      spawnedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calls.some((c) => c.url === '/api/stories/s1/reference-candidates/c1/declare')).toBe(true);
    const kindCall = calls.find((c) => c.url === '/api/stories/s1/reference-candidates/c1/relation-kind');
    expect(kindCall).toBeDefined();
    expect(JSON.parse(kindCall!.init!.body as string)).toEqual({ relation_kind: 'spawned' });
    expect(onCandidateResolved).toHaveBeenCalledTimes(1);
    // 다음 후보(#102)로 자동 전진 — 다시 열지 않았다(왕복 1).
    expect(document.body.textContent).toContain('#1에서 #102로 잇습니다');
    expect(document.body.textContent).toContain('2 / 2');
  });

  it('"종류는 모르겠지만" declares without calling relation-kind', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls);
    await renderQueue();

    const unknownButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '종류는 모르겠지만 이어진 건 맞습니다');
    await act(async () => {
      unknownButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calls.some((c) => c.url === '/api/stories/s1/reference-candidates/c1/declare')).toBe(true);
    expect(calls.some((c) => c.url.includes('relation-kind'))).toBe(false);
    expect(document.body.textContent).toContain('2 / 2');
  });

  it('"관계가 아닙니다" calls reject, not declare', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls);
    await renderQueue();

    const rejectButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '관계가 아닙니다');
    await act(async () => {
      rejectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calls.some((c) => c.url === '/api/stories/s1/reference-candidates/c1/reject')).toBe(true);
    expect(calls.some((c) => c.url.includes('/declare'))).toBe(false);
    expect(document.body.textContent).toContain('2 / 2');
  });

  it('"나중에" skips to the next candidate WITHOUT any server call', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls);
    await renderQueue();
    const callsBeforeSkip = calls.length;

    const laterButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '나중에');
    await act(async () => {
      laterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 로드 이후로 새 네트워크 호출이 하나도 없어야 한다("서버에 아무것도 안 남는다").
    expect(calls.length).toBe(callsBeforeSkip);
    expect(document.body.textContent).toContain('#1에서 #102로 잇습니다');
  });
});

describe('FlowRelationReviewQueue — 다 훑으면 「N건 확認함」이 남는다', () => {
  it('shows the done summary after handling every candidate — count excludes skipped ones', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls);
    await renderQueue();

    // 1번째: 나중에(스킵, handledCount에 안 들어간다)
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '나중에')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 2번째: 기각(handledCount에 들어간다)
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '관계가 아닙니다')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(document.body.textContent).toContain('1건 확인함');
  });
});

describe('FlowRelationReviewQueue — 실패 처리(고정 폴백, #2485 그라운딩)', () => {
  it('shows a fixed fallback message on failure and does NOT advance the queue', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls, { '/declare': () => ({ ok: false, json: async () => null }) });
    await renderQueue();

    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '종류는 모르겠지만 이어진 건 맞습니다')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(document.body.textContent).toContain('연결하지 못했습니다');
    // 실패했으니 여전히 1번째 후보 자리 그대로다.
    expect(document.body.textContent).toContain('1 / 2');
  });
});
