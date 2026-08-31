// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ActionZone, QueueRow } from './action-zone';
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
      { type: 'agent_stuck', severity: 'warn', auto_detected: true, entity_type: 'story', entity_id: 's1', gate_type: 'qa', stuck_since: '2026-07-10T00:00:00Z' },
    ],
    pending: [],
  },
  is_clear: false,
};

describe('ActionZone attention row (command-center-surveillance-reframe-handoff — "대기는 경보가 아니라 상태")', () => {
  it('renders "게이트 대기 중" copy without a precise elapsed-minutes count or "멈춤" wording', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone data={DATA} resolveName={() => null} epicTitles={{}} />));
    expect(markup).toContain('QA 대기 중'); // gate_type='qa' → 번역 라벨(gateLabel), 원시값 안 보임(PO 지적 2026-07-29)
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

// story #3150(시연 리허설 발견) — AttentionItem이 실제로는 (당시)8종인데 AttentionRow가
// 'agent_stuck' 전용 필드(entity_id/entity_type)만 읽어 나머지는 <span class="font-medium">
// 이 통째로 공백 렌더되던 것(58건 실측). 각 타입이 BE(#2538 계약)가 이미 싣는 title/
// statement/blocked_story_title을 그대로 보여주는지 회귀가드. ⛔story #3154 — 'story_stalled'
// 는 BE가 완전 제거해(story #93b076c8, twin 신호 정리) 지금은 7종 → 6종 전수(이 describe
// 스코프)만 남았다.
describe('ActionZone attention row — story #3150 6종 전수(BE title/statement 폴백 없이 직접 소비)', () => {
  function attentionData(item: MyActions['attention']['items'][number]): MyActions {
    return {
      action_queue: { scope: 'project', items: [] },
      attention: { scope: 'project', items: [item], pending: [] },
      is_clear: false,
    };
  }

  it('unanswered_blocker — blocked_story_title+age_days를 그대로 보여준다', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone
      data={attentionData({ type: 'unanswered_blocker', severity: 'warn', auto_detected: true, blocked_story_id: 's2', blocker_id: 's3', blocked_story_title: '온보딩 완주 체크', age_days: 5, project_id: 'p1' })}
      resolveName={() => null} epicTitles={{}}
    />));
    expect(markup).toContain('온보딩 완주 체크');
    expect(markup).toContain('5일째');
  });

  it('hypothesis_falsified — statement를 그대로 보여준다(days 없으면 확인 필요 폴백)', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone
      data={attentionData({ type: 'hypothesis_falsified', severity: 'info', auto_detected: true, hypothesis_id: 'h1', statement: '위클리 다이제스트가 리텐션을 높인다', outcome_result: null, falsified_days: null, superseded_by_hypothesis_id: null, project_id: 'p1' })}
      resolveName={() => null} epicTitles={{}}
    />));
    expect(markup).toContain('위클리 다이제스트가 리텐션을 높인다');
    expect(markup).toContain('확인 필요');
  });

  it('loop_overdue_hypothesis — statement+overdue_days', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone
      data={attentionData({ type: 'loop_overdue_hypothesis', severity: 'warn', auto_detected: true, hypothesis_id: 'h2', statement: '리뷰 에이전트가 결함을 줄인다', owner_member_id: null, overdue_days: 3, project_id: 'p1' })}
      resolveName={() => null} epicTitles={{}}
    />));
    expect(markup).toContain('리뷰 에이전트가 결함을 줄인다');
    expect(markup).toContain('3일째');
  });

  it('loop_overdue_goal — title+overdue_days', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone
      data={attentionData({ type: 'loop_overdue_goal', severity: 'warn', auto_detected: true, goal_id: 'g1', title: '가입 전환율 개선', owner_member_id: null, overdue_days: 10, project_id: 'p1' })}
      resolveName={() => null} epicTitles={{}}
    />));
    expect(markup).toContain('가입 전환율 개선');
    expect(markup).toContain('10일째');
  });

  it('loop_outcome_missing_goal — title+done_days', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone
      data={attentionData({ type: 'loop_outcome_missing_goal', severity: 'warn', auto_detected: true, goal_id: 'g2', title: '온보딩 완주율', owner_member_id: null, done_days: 7, project_id: 'p1' })}
      resolveName={() => null} epicTitles={{}}
    />));
    expect(markup).toContain('온보딩 완주율');
    expect(markup).toContain('7일째');
  });

  it('agent_auth_failure — resolveName으로 멤버명 해소+실패 횟수', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone
      data={attentionData({ type: 'agent_auth_failure', severity: 'danger', auto_detected: true, member_id: 'm1', reason: 'expired', failure_count: 4, first_failed_at: '2026-08-27T00:00:00Z', last_failed_at: '2026-08-27T01:00:00Z' })}
      resolveName={(id) => (id === 'm1' ? '까디르 아흐마디' : null)} epicTitles={{}}
    />));
    expect(markup).toContain('까디르 아흐마디');
    expect(markup).toContain('인증 실패 4회');
  });

  it('agent_auth_failure — resolveName이 못 찾으면 reason으로 폴백(빈 값 아님)', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone
      data={attentionData({ type: 'agent_auth_failure', severity: 'danger', auto_detected: true, member_id: 'm-unknown', reason: 'revoked', failure_count: 1, first_failed_at: null, last_failed_at: null })}
      resolveName={() => null} epicTitles={{}}
    />));
    expect(markup).toContain('revoked');
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

describe('ActionZone — story #2288, PO 지시(2026-07-29): 못 알아보는 타입은 요약 한 줄로', () => {
  it('QueueRow가 모르는 type은 개별 줄로 안 뜨고(소음 없음), review_merge로도 오인 렌더 안 된다', async () => {
    // BE가 FE 미선언 새 타입을 보내는 상황 재현 — 런타임에는 TS 유니온이 못 막는다.
    const unknownItem = queueItem('gate_approval', { title: '알수없음' });
    (unknownItem as { type: string }).type = 'brand_new_be_type';
    await render({
      action_queue: { scope: 'project', items: [unknownItem] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).not.toContain('새 종류의 항목'); // 개별 줄은 안 그린다(splitRenderableQueue가 걸러냄).
    expect(container.textContent).not.toContain('리뷰·머지 대기');
    expect(container.textContent).toContain('1건은 표시할 수 없습니다'); // 대신 요약 한 줄.
  });

  it('인식되는 항목과 못 알아보는 항목이 섞이면, 아는 것은 정상 렌더하고 모르는 것만 요약에 센다', async () => {
    const known = queueItem('gate_approval');
    const unknown1 = queueItem('gate_approval');
    (unknown1 as { type: string }).type = 'brand_new_be_type_a';
    const unknown2 = queueItem('gate_approval');
    (unknown2 as { type: string }).type = 'brand_new_be_type_b';
    await render({
      action_queue: { scope: 'project', items: [known, unknown1, unknown2] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('게이트 승인 대기');
    expect(container.textContent).toContain('2건은 표시할 수 없습니다');
  });
});

describe('QueueRow — story #2288: 방어선(defense-in-depth) 단위테스트, splitRenderableQueue를 우회해 직접 호출한 경우', () => {
  it('인식 못한 type이 직접 들어와도 review_merge 문구로 오인 렌더하지 않고 미확인 표시를 낸다', async () => {
    const unknownItem = queueItem('gate_approval');
    (unknownItem as { type: string }).type = 'brand_new_be_type';
    await act(async () => { root.render(wrap(<QueueRow item={unknownItem} />)); });
    expect(container.textContent).toContain('새 종류의 항목');
    expect(container.textContent).not.toContain('리뷰·머지 대기');
  });

  it('개발 환경에서 console.warn으로 남긴다(다음 사람이 새 타입이 온 것을 바로 알 수 있게)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknownItem = queueItem('gate_approval');
    (unknownItem as { type: string }).type = 'brand_new_be_type';
    await act(async () => { root.render(wrap(<QueueRow item={unknownItem} />)); });
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

  it('story #2288, PO 확認(2026-07-29): attention(감지 신호) 쪽 새 항목도 같은 배너에 합산된다', async () => {
    store.set('sprintable:command-center:v1:last-seen-actions', String(new Date('2026-07-29T00:00:00Z').getTime()));
    await render({
      action_queue: { scope: 'project', items: [] },
      attention: {
        scope: 'project',
        items: [{ type: 'agent_stuck', severity: 'warn', auto_detected: true, entity_type: 'story', entity_id: 'e1', gate_type: null, stuck_since: '2026-07-29T01:00:00Z' }],
        pending: [],
      },
      is_clear: false,
    });
    expect(container.textContent).toContain('내 것 1건에 변경이 있었습니다');
  });
});

describe('ActionZone — story #2288, BE 명세4(#2650) waiting_on_others: 「기다리는 것」 별도 구역', () => {
  it('waiting_on_others 항목은 행동 큐가 아니라 별도 「기다리는 것」 구역에 뜬다', async () => {
    await render({
      action_queue: { scope: 'project', items: [queueItem('waiting_on_others', { context: { story_id: 's1', gate_type: 'qa' } })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('기다리는 것');
    expect(container.textContent).toContain('QA 대기 중'); // 번역 라벨 — 원시값 'qa' 그대로 안 나옴(PO 지적)
  });

  it('§3-1㉢, PO 정정(2026-07-29): 판별자는 "상태를 바꾸는가"이지 "클릭 가능한가"가 아니다 — 구역 안에 상태변경 컨트롤 0개 + 「가는」 링크는 있어야 한다(양성대조 둘)', async () => {
    await render({
      action_queue: {
        scope: 'project',
        items: [
          queueItem('gate_approval', { context: { kind: '결재자', gate_type: 'qa' } }), // 양성 대조①: 행동 항목
          queueItem('waiting_on_others', { context: { story_id: 's1', gate_type: 'qa' } }),
        ],
      },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    const waitingZone = container.querySelector('[data-testid="cc-waiting-zone"]');
    expect(waitingZone).not.toBeNull();
    // 「없어야 할 것이 없다」 — 상태를 바꾸는 컨트롤(버튼·role=button·form) 0개.
    expect(waitingZone!.querySelectorAll('button, [role="button"], form')).toHaveLength(0);
    // 「있어야 할 것이 있다」 — 양성대조②: 「가서 보는」 링크는 구역 «안에» 있어야 한다
    // (없으면 「내가 기다리는 그것」을 확認할 길이 없다 — 「해소」 목적 자체가 안 선다).
    expect(waitingZone!.querySelectorAll('a').length).toBeGreaterThan(0);
    // 양성대조①: 행동 항목(게이트 승인 대기)은 컨테이너 전체 기준으로 링크가 있다.
    expect(container.querySelectorAll('a').length).toBeGreaterThan(waitingZone!.querySelectorAll('a').length);
  });

  it('gate_type이 없으면(null) 일반 라벨로 대체한다(사람을 지어내지 않는다)', async () => {
    await render({
      action_queue: { scope: 'project', items: [queueItem('waiting_on_others', { context: { story_id: 's1', gate_type: null } })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('게이트 대기 중');
  });

  it('waiting_on_others는 잘림 표시(§7-4) 대상 큐에서 빠진다 — 행동 큐 cap과 별개다', async () => {
    const items: QueueItem[] = [
      ...Array.from({ length: 5 }, () => queueItem('review_merge')),
      ...Array.from({ length: 3 }, (_, i) => queueItem('waiting_on_others', { context: { story_id: `w${i}`, gate_type: 'qa' } })),
    ];
    await render({
      action_queue: { scope: 'project', items },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    // 행동 큐는 review_merge 5건 = cap 이하라 안 잘림. waiting 3건은 별도 구역에 전부 뜬다.
    expect(container.textContent).not.toContain('건을 보이고 있습니다');
    expect(container.textContent).toContain('기다리는 것');
  });

  it('gate_approval 항목에 gate_type이 실리면 번역된 라벨로 함께 보인다(#2650 BE 명세3, PO 지적: 원시값 금지)', async () => {
    await render({
      action_queue: { scope: 'project', items: [queueItem('gate_approval', { context: { kind: '결재자', gate_type: 'deploy' } })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('배포');
    expect(container.textContent).not.toContain('deploy');
  });

  it('PO 지적(2026-07-29): 맵에 없는 gate_type이 오면 원시값을 안 내보내고 일반 라벨(null과 같은 자리)로 떨어진다', async () => {
    await render({
      action_queue: { scope: 'project', items: [queueItem('waiting_on_others', { context: { story_id: 's1', gate_type: 'some_future_unknown_gate' } })] },
      attention: { scope: 'project', items: [], pending: [] },
      is_clear: false,
    });
    expect(container.textContent).toContain('게이트 대기 중');
    expect(container.textContent).not.toContain('some_future_unknown_gate');
  });
});
