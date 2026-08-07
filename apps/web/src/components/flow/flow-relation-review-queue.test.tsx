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
  { id: 't1', story_number: 101, title: 'Target One', epic_id: 'epic-1' },
  { id: 't2', story_number: 102, title: 'Target Two', epic_id: 'epic-1' },
];

function stubFetch(
  calls: Array<{ url: string; init?: RequestInit }>,
  overrides: Record<string, () => { ok: boolean; json: () => Promise<unknown> }> = {},
  data: { candidates?: unknown[]; stories?: unknown[] } = {},
) {
  const candidates = data.candidates ?? CANDIDATES;
  const stories = data.stories ?? STORIES;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler();
    }
    if (url === '/api/stories/s1/reference-candidates') {
      return { ok: true, json: async () => candidates };
    }
    if (url.startsWith('/api/stories?ids=')) {
      return { ok: true, json: async () => ({ data: stories }) };
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

async function renderQueue(
  onClose = () => {},
  onCandidateResolved?: () => void,
  extraProps: Partial<React.ComponentProps<typeof FlowRelationReviewQueue>> = {},
) {
  await act(async () => {
    root.render(wrap(
      <FlowRelationReviewQueue
        storyId="s1"
        storyNumber={1}
        epicId="epic-1"
        onClose={onClose}
        onCandidateResolved={onCandidateResolved}
        {...extraProps}
      />,
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

describe('FlowRelationReviewQueue — target 조회 실패 방어(PR#2900 카디르 QA LOW①)', () => {
  it('disables declare/reject when the target story lookup failed — only "나중에"(skip) stays enabled', async () => {
    const calls: Array<{ url: string }> = [];
    // /api/stories?ids= 자체가 실패해 targetInfo가 빈 채로 남는 상황을 재현한다.
    stubFetch(calls, { '/api/stories?ids=': () => ({ ok: false, json: async () => null }) });
    await renderQueue();

    expect(document.body.textContent).toContain('상대 스토리 정보를 불러오지 못해');
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const label of ['여기서 나온 일', '다음에 할 일', '대신하는 일', '종류는 모르겠지만 이어진 건 맞습니다', '관계가 아닙니다']) {
      const btn = buttons.find((b) => b.textContent === label);
      expect(btn?.disabled, `${label} should be disabled`).toBe(true);
    }
    const laterBtn = buttons.find((b) => b.textContent === '나중에');
    expect(laterBtn?.disabled).toBe(false);

    // 스킵은 여전히 되고, 서버에 declare/reject 호출은 하나도 안 나간다.
    await act(async () => {
      laterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.some((c) => c.url.includes('/declare') || c.url.includes('/reject'))).toBe(false);
    expect(document.body.textContent).toContain('2 / 2');
  });
});

describe('FlowRelationReviewQueue — 묶음 상한·정렬(AC11·12, 2026-08-07 디디 실측 후속)', () => {
  // ⛔"cap(기본 20) > 실측 max(17)라 초과 경로가 원천 안 걸린다"로 닫지 않는다(#2366 AC9
  // 규율) — queueCap을 일부러 낮춰 실제 초과 상태를 만들고 정렬이 도는지 값으로 잰다.
  const CANDIDATES_3 = [
    { id: 'c1', source_id: 's1', target_id: 'other-epic', relation_kind: null, status: 'estimated' },
    { id: 'c2', source_id: 's1', target_id: 't1', relation_kind: null, status: 'estimated' },
    { id: 'c3', source_id: 's1', target_id: 't2', relation_kind: null, status: 'estimated' },
  ];
  const STORIES_3 = [
    { id: 'other-epic', story_number: 999, title: 'Different Branch', epic_id: 'epic-OTHER' },
    { id: 't1', story_number: 101, title: 'Target One', epic_id: 'epic-1' },
    { id: 't2', story_number: 102, title: 'Target Two', epic_id: 'epic-1' },
  ];

  it('caps the working queue and shows same-epic ("지금 보는 갈래") targets before others', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls, {}, { candidates: CANDIDATES_3, stories: STORIES_3 });
    // cap=2로 낮춰 3건 중 2건만 노출되는 실제 초과 경로를 강제한다.
    await renderQueue(() => {}, undefined, { queueCap: 2 });

    // 상한이 걸렸으므로 진행 표시는 "N / 2"다(전체 3건이 아니라).
    expect(document.body.textContent).toContain('1 / 2');
    // 같은 갈래(epic-1)의 두 후보(#101·#102)가 먼저 오고, 다른 갈래(#999)는 이번 묶음에서 빠진다.
    expect(document.body.textContent).toContain('#1에서 #101로 잇습니다');

    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '나중에')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.body.textContent).toContain('#1에서 #102로 잇습니다');
    expect(document.body.textContent).not.toContain('#999');
  });

  it('does not cap or reorder when the unconfirmed count is at or below the cap (regression guard)', async () => {
    const calls: Array<{ url: string }> = [];
    stubFetch(calls, {}, { candidates: CANDIDATES_3, stories: STORIES_3 });
    // cap=3(정확히 후보 수) — 전부 노출되고, 원래 순서(도착 순)가 그대로 유지된다.
    await renderQueue(() => {}, undefined, { queueCap: 3 });

    expect(document.body.textContent).toContain('1 / 3');
    // 정렬을 안 타므로 원래 배열 순서 그대로 첫 항목은 다른 갈래(#999)다.
    expect(document.body.textContent).toContain('#999');
  });
});
