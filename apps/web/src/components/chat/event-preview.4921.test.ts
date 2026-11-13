import { describe, expect, it } from 'vitest';
import { composeEventPreviewFallback, composeEventPreviewLine, humanizeMachineEventSummary, isMachineEventContent, type EventPreviewHelpers } from './event-block-card';

// story 4921 — the one line a person sees for an event message: a sentence for the direction instruction, and for every event WITHOUT a sentence of its own the definition's name + the person's own words
// (or the one word «이벤트») — never the machine text an agent reads (a slug · ids · «- key: value» lines · «[이벤트]»).
const COPY: Record<string, string> = { steerHeader: '방향 전환', memberMissing: '(알 수 없는 구성원)', genericEventHeader: '이벤트' };
const helpers: EventPreviewHelpers = {
  tBoard: (k) => k, tCage: (k) => k, tDashboard: (k) => k, tEventCard: (k) => COPY[k] ?? k, tEntity: (k) => k, tOutcomeLoop: (k) => k,
  domainLabels: { statusLabel: () => undefined },
  eventDefinitionName: (key) => ({ 'preset.marketing.video_production': '영상 제작', 'org.acme.signup': '가입 알림', 'preset.workflow.kanban': '칸반 워크플로우' } as Record<string, string>)[key],
};
const UUID = '97470487-345a-4e85-9c45-cdf901737adb';
/** a person must not see any of this */
const LEAK = /preset\.|org\.[a-z]|[0-9a-f]{8}-[0-9a-f]{4}-|^- \w+:|\n- |\[이벤트\]|\[Event\]|work_item|target_member_id|\bstage:/;

describe('composeEventPreviewLine — 방향 지시(story 4921)', () => {
  it('⭐«방향 전환 · {지시 글} → {대상 이름}»', () => {
    expect(composeEventPreviewLine('preset.steer.instruct', { instruction: '먼저 봐 주세요', target_member_id: UUID }, helpers, { target: { found: true, name: '미르코' } }))
      .toBe('방향 전환 · 먼저 봐 주세요 → 미르코');
  });
  it('⭐옛 메시지(refs.target 없음): « → 이름» 없이 «방향 전환 · {지시 글}» — 거짓 «알 수 없는»이 아니다', () => {
    expect(composeEventPreviewLine('preset.steer.instruct', { instruction: '옛 지시', target_member_id: UUID }, helpers, undefined)).toBe('방향 전환 · 옛 지시');
    expect(composeEventPreviewLine('preset.steer.instruct', { instruction: '옛 지시' }, helpers, {})).toBe('방향 전환 · 옛 지시');
  });
  it('구성원이 지금 없으면(found:false) « → (알 수 없는 구성원)» — uuid 아님', () => {
    const line = composeEventPreviewLine('preset.steer.instruct', { instruction: '지시', target_member_id: UUID }, helpers, { target: { found: false } });
    expect(line).toBe('방향 전환 · 지시 → (알 수 없는 구성원)');
    expect(line).not.toContain(UUID);
  });
  it('지시 글이 여러 줄이면 첫 줄만, 길면 60자에서 자른다', () => {
    expect(composeEventPreviewLine('preset.steer.instruct', { instruction: '첫 줄\n둘째 줄' }, helpers)).toBe('방향 전환 · 첫 줄');
    const long = '가'.repeat(80);
    expect(composeEventPreviewLine('preset.steer.instruct', { instruction: long }, helpers)).toBe(`방향 전환 · ${'가'.repeat(60)}…`);
  });
  it('지시 글이 없으면 null(호출부가 폴백)', () => {
    expect(composeEventPreviewLine('preset.steer.instruct', { target_member_id: UUID }, helpers)).toBeNull();
  });
});

describe('isMachineEventContent / composeEventPreviewFallback — 문장이 없는 이벤트 전부(story 4921)', () => {
  const MACHINE = (key: string, extra = '') => `[이벤트] ${key}\n- work_item_id: ${UUID}\n- stage: draft${extra}`;
  it('⭐기계 문장 감지: «[이벤트] x» / «[Event] x»로 시작하면 기계 문장, 사람이 쓴 글은 아니다', () => {
    expect(isMachineEventContent('[이벤트] preset.x\n- a: b')).toBe(true);
    expect(isMachineEventContent('[Event] preset.x\n- a: b')).toBe(true);
    expect(isMachineEventContent('발행이 멈췄어요. 다시 시도해 주세요.')).toBe(false);
    expect(isMachineEventContent('[이벤트]')).toBe(false);
    expect(isMachineEventContent(undefined)).toBe(false);
  });
  it.each([
    ['워크플로우 stage(정의 이름 있음)', 'preset.workflow.kanban', { stage: 'ready', work_item_id: UUID }, '칸반 워크플로우'],
    ['마케팅 레시피(정의 이름 있음)', 'preset.marketing.video_production', { stage: 'draft', work_item_type: 'story', work_item_id: UUID }, '영상 제작'],
    ['조직 커스텀 이벤트(정의 이름 있음 + 사람 글)', 'org.acme.signup', { message: '새 가입이 들어왔어요\n둘째 줄', user_id: UUID }, '가입 알림 · 새 가입이 들어왔어요'],
    ['정의 이름을 모르는 이벤트 — 한 낱말 «이벤트»', 'preset.recipe.publish_failed', { stage: 'published', reason_code: 'x', work_item_id: UUID }, '이벤트'],
    ['정의 이름을 모르는데 사람 글이 있으면 «이벤트 · 글»', 'org.zeta.note', { summary: '정리 끝', ref: UUID }, '이벤트 · 정리 끝'],
  ])('⭐%s → 슬러그 · id · 키 이름 · «[이벤트]» 노출 0', (_n, key, payload, expected) => {
    const line = composeEventPreviewFallback(MACHINE(key), key, payload, helpers);
    expect(line).toBe(expected);
    expect(line).not.toMatch(LEAK);
  });
  it('사람이 쓴 content(기계 문장이 아님)는 null — 호출부가 그대로 보인다(예: 발행 멈춤의 설명 문장)', () => {
    expect(composeEventPreviewFallback('발행이 멈췄어요. 작업 상세에서 다시 시도해 주세요.', 'preset.recipe.publish_failed', { reason_code: 'x' }, helpers)).toBeNull();
  });
  it('사람 글 칸은 순서대로 첫 번째만(instruction → message → summary …), id · 상태 칸은 절대 쓰지 않는다', () => {
    const line = composeEventPreviewFallback(MACHINE('org.x.y'), 'org.x.y', { stage: 'draft', status: 'open', work_item_id: UUID, note: '메모 글' }, helpers);
    expect(line).toBe('이벤트 · 메모 글');
    expect(line).not.toMatch(LEAK);
  });
  it('en 기계 머리줄도 같다', () => {
    expect(composeEventPreviewFallback('[Event] preset.workflow.kanban\n- stage: ready', 'preset.workflow.kanban', { stage: 'ready' }, helpers)).toBe('칸반 워크플로우');
  });
  it('⭐title · body · content · reason는 사람 글 칸이 아니다(워크플로우 · 레시피 payload가 슬러그 · 경로를 싣는다) — 쓰지 않는다', () => {
    const line = composeEventPreviewFallback(MACHINE('org.x.y'), 'org.x.y', { title: '/api/v2/stories/946300bd-434c-45d6-901d-c0d1af8603e7', body: 'body 글', content: 'content 글', reason: 'reason 글' }, helpers);
    expect(line).toBe('이벤트');
  });
  it('⭐사람 글 칸이어도 id · 경로 · 링크 · entity 토큰인 줄은 글이 아니다 → 다음 칸 · 없으면 «이벤트»', () => {
    expect(composeEventPreviewFallback(MACHINE('org.x.y'), 'org.x.y', { message: '946300bd-434c-45d6-901d-c0d1af8603e7', summary: '정리 끝' }, helpers)).toBe('이벤트 · 정리 끝');
    for (const bad of ['/api/v2/stories/1', 'https://example.test/a', '[제목](entity:story:946300bd-434c-45d6-901d-c0d1af8603e7)', 'entity:story:abc']) {
      expect(composeEventPreviewFallback(MACHINE('org.x.y'), 'org.x.y', { message: bad }, helpers)).toBe('이벤트');
    }
  });
  it('⭐자를 때 이모지(서러게이트 쌍)를 반으로 가르지 않는다 — 60자 경계에 이모지가 걸려도 온전', () => {
    const text = `${'가'.repeat(59)}😀뒤에 더 있는 글`;
    const line = composeEventPreviewFallback(MACHINE('org.x.y'), 'org.x.y', { note: text }, helpers)!;
    expect(line).toBe(`이벤트 · ${'가'.repeat(59)}😀…`);
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
  it('⭐방향 지시 문장도 같은 규칙 — 지시 글이 id · 경로면 문장을 짓지 않는다(null → 폴백)', () => {
    expect(composeEventPreviewLine('preset.steer.instruct', { instruction: '/api/v2/x' }, helpers)).toBeNull();
  });
});

describe('humanizeMachineEventSummary — a stored «{sender}: [이벤트] …» summary (story 4921)', () => {
  const t = (k: string) => COPY[k] ?? k;
  it('⭐기계 문장 요약은 «{보낸 이}: 이벤트[ · 사람 글]»로 — 슬러그 · id · key: value 없음', () => {
    const summary = `시스템 발행: [이벤트] preset.workflow.kanban\n- stage: ready\n- work_item_id: ${UUID}`;
    const line = humanizeMachineEventSummary(summary, { event_key: 'preset.workflow.kanban', payload: { stage: 'ready' } }, t);
    expect(line).toBe('시스템 발행: 이벤트');
    expect(line).not.toMatch(LEAK);
    expect(humanizeMachineEventSummary('페드루: [이벤트] preset.steer.instruct - instruction: 지시', { event_key: 'preset.steer.instruct', payload: { instruction: '먼저 봐 주세요' } }, t)).toBe('페드루: 방향 전환 · 먼저 봐 주세요');
    expect(humanizeMachineEventSummary('Someone: [Event] org.x.y\n- a: b', undefined, t)).toBe('Someone: 이벤트');
  });
  it('기계 문장이 아닌 요약 · 빈 값은 그대로', () => {
    expect(humanizeMachineEventSummary('미르코: 안녕하세요', { event_key: 'x', payload: {} }, t)).toBe('미르코: 안녕하세요');
    expect(humanizeMachineEventSummary('방향 전환 · 먼저 봐 주세요 → 미르코', undefined, t)).toBe('방향 전환 · 먼저 봐 주세요 → 미르코');
    expect(humanizeMachineEventSummary(undefined, undefined, t)).toBeUndefined();
    expect(humanizeMachineEventSummary(null, undefined, t)).toBeNull();
    expect(humanizeMachineEventSummary('[이벤트]', undefined, t)).toBe('[이벤트]');
  });
});

describe('the text fallback carries the steer sentence and the legacy summary keeps the target (story 4921)', () => {
  const t = (k: string) => COPY[k] ?? k;
  it('⭐composeEventPreviewFallback of a steer with refs.target = the same sentence as composeEventPreviewLine', () => {
    const refs = { target: { found: true, name: '미르코' } };
    expect(composeEventPreviewFallback('[이벤트] preset.steer.instruct\n- instruction: x', 'preset.steer.instruct', { instruction: '먼저 봐 주세요' }, { tEventCard: t }, refs)).toBe('방향 전환 · 먼저 봐 주세요 → 미르코');
    expect(composeEventPreviewFallback('[이벤트] preset.steer.instruct\n- instruction: x', 'preset.steer.instruct', { instruction: '먼저 봐 주세요' }, { tEventCard: t })).toBe('방향 전환 · 먼저 봐 주세요');
  });
  it('⭐a stored machine summary of a steer: «{보낸 이}: 방향 전환 · … → 이름»', () => {
    const line = humanizeMachineEventSummary('페드루: [이벤트] preset.steer.instruct - instruction: x', { event_key: 'preset.steer.instruct', payload: { instruction: '먼저 봐 주세요' }, refs: { target: { found: true, name: '미르코' } } }, t);
    expect(line).toBe('페드루: 방향 전환 · 먼저 봐 주세요 → 미르코');
  });
});