// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ActionZone } from './action-zone';
import type { MyActions, QueueItem } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const DATA: MyActions = {
  action_queue: { scope: 'project', items: [] },
  attention: {
    scope: 'project',
    items: [
      { type: 'agent_stuck', severity: 'warn', auto_detected: true, entity_type: 'story', entity_id: 's1', gate_type: '리뷰', stuck_since: '2026-07-10T00:00:00Z' },
    ],
    pending: [],
  },
  is_clear: false,
};

describe('ActionZone attention row (command-center-surveillance-reframe-handoff — "대기는 경보가 아니라 상태")', () => {
  it('renders "게이트 대기 중" copy without a precise elapsed-minutes count or "멈춤" wording', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone data={DATA} resolveName={() => null} epicTitles={{}} />));
    expect(markup).toContain('리뷰 대기 중');
    expect(markup).not.toContain('멈춤');
    expect(markup).not.toMatch(/\d+\s*분째/);
  });

  it('uses a neutral border/dot tone, never the warning color, for the stuck-item card', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone data={DATA} resolveName={() => null} epicTitles={{}} />));
    expect(markup).not.toContain('border-warning');
    expect(markup).not.toContain('bg-warning');
    expect(markup).toContain('bg-info/60');
  });

  it('renders the calm "지금 볼 것" section heading, not an alarm framing', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone data={DATA} resolveName={() => null} epicTitles={{}} />));
    expect(markup).toContain('지금 볼 것');
    expect(markup).not.toContain('주의');
  });
});

function queueItem(type: QueueItem['type'], overrides: Partial<QueueItem> = {}): QueueItem {
  return { type, priority: 'info', context: {}, created_at: null, ...overrides };
}

let container: HTMLDivElement;
let root: Root;
let store: Map<string, string>;

beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(data: MyActions) {
  await act(async () => {
    root.render(wrap(<ActionZone data={data} resolveName={() => null} epicTitles={{}} />));
  });
}

describe('ActionZone — story #2288 my_blockers 타입 fix', () => {
  it('my_blockers 항목을 review_merge 문구로 오인 렌더하지 않고 「내가 막고 있음」으로 그린다', async () => {
    await render({
      action_queue: { scope: 'project', items: [queueItem('my_blockers', { title: '차단 대상 스토리' })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('내가 막고 있음');
    expect(container.textContent).not.toContain('리뷰·머지 대기');
  });
});

describe('ActionZone — story #2288, PO 지적(2026-07-29): BE-FE 타입 목록 어긋남 가드', () => {
  it('QueueRow가 모르는 type이 오면 review_merge 문구로 조용히 오인 렌더하지 않고 미확인 표시를 낸다', async () => {
    // BE가 FE 미선언 새 타입을 보내는 상황 재현 — 런타임에는 TS 유니온이 못 막는다.
    const unknownItem = queueItem('gate_approval', { title: '알수없음' });
    (unknownItem as { type: string }).type = 'brand_new_be_type';
    await render({
      action_queue: { scope: 'project', items: [unknownItem] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('새 종류의 항목');
    expect(container.textContent).not.toContain('리뷰·머지 대기');
  });

  it('개발 환경에서 console.warn으로 남긴다(다음 사람이 새 타입이 온 것을 바로 알 수 있게)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknownItem = queueItem('gate_approval');
    (unknownItem as { type: string }).type = 'brand_new_be_type';
    await render({
      action_queue: { scope: 'project', items: [unknownItem] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'ActionZone/QueueRow: unrecognized action_queue item type',
      expect.objectContaining({ type: 'brand_new_be_type' }),
    );
    warnSpy.mockRestore();
  });
});

describe('ActionZone — story #2288 §7-4·§8-4 잘림 표시·자르는 순서', () => {
  it('큐가 cap 이하면 잘림 표시가 없다', async () => {
    await render({
      action_queue: { scope: 'project', items: [queueItem('review_merge')] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).not.toContain('보이고 있습니다');
  });

  it('큐가 cap을 넘으면 잘림 표시가 뜨고, review_merge가 gate_approval/my_blockers보다 먼저 잘린다', async () => {
    const items: QueueItem[] = [
      ...Array.from({ length: 6 }, () => queueItem('review_merge')),
      queueItem('gate_approval'),
      queueItem('my_blockers'),
    ];
    await render({
      action_queue: { scope: 'project', items },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('8건 중 5건을 보이고 있습니다');
    // 보호 항목(결재 대기·내가 막고 있음)은 잘리지 않고 반드시 보인다.
    expect(container.textContent).toContain('게이트 승인 대기');
    expect(container.textContent).toContain('내가 막고 있음');
  });
});

describe('ActionZone — story #2288 §8-8 자리를 비운 사이', () => {
  it('첫 방문(기준점 없음)에는 변경 배너를 안 띄운다(모름을 전부 새것으로 지어내지 않는다)', async () => {
    await render({
      action_queue: { scope: 'project', items: [queueItem('review_merge', { created_at: '2026-07-29T00:00:00Z' })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).not.toContain('변경이 있었습니다');
  });

  it('마지막 방문 이후 생긴 항목이 있으면 그 수를 접힌 줄로 보인다', async () => {
    store.set('sprintable:command-center:v1:last-seen-actions', String(new Date('2026-07-29T00:00:00Z').getTime()));
    await render({
      action_queue: { scope: 'project', items: [queueItem('review_merge', { created_at: '2026-07-29T01:00:00Z' })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('내 것 1건에 변경이 있었습니다');
  });

  it('방문 시 기준점을 갱신한다(다음 렌더에서 같은 항목을 다시 새것으로 안 센다)', async () => {
    store.set('sprintable:command-center:v1:last-seen-actions', String(new Date('2026-07-29T00:00:00Z').getTime()));
    const data: MyActions = {
      action_queue: { scope: 'project', items: [queueItem('review_merge', { created_at: '2026-07-29T01:00:00Z' })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    };
    await render(data);
    expect(container.textContent).toContain('내 것 1건에 변경이 있었습니다');

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render(data); // 같은 data, 재마운트 — 기준점이 갱신됐으면 더 이상 "새것"이 아니다.
    expect(container.textContent).not.toContain('변경이 있었습니다');
  });
});
