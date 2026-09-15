// @vitest-environment jsdom
//
// story #3886(E-UX-OVERHAUL·§⑤·Chat·customer-zero·가드) — preset 블록 템플릿 «소비처 전수»
// 회귀 테스트. 출처: PR 4288(#3881) 착지 뒤 develop 7dc00dfd7에서 twin 소비처
// approval-request-card.tsx(:509 labels 미전달)에 `⟨missing: label.gate_type⟩`가 실제로
// 새고 있었다(디디 4290 그라운딩·PO 재측 확認·카디르 verdict 관찰). 원인 클래스: block-
// template.ts의 머스태시 네임스페이스/렌더 인자를 넓히는 변경은 완전 additive라 타입·기존
// 테스트가 안 깨지고, 새 인자를 못 받은 두 번째 소비처는 fail-loud 마커를 «사용자에게» 낸다.
//
// 이 파일은 두 층을 가른다:
// AC2 — 완전성 자: `renderBlockTemplate(` 실 호출부를 src 전수 grep(정의 자체·테스트 파일
//       제외)해 «기대 집합»과 정확히 일치하는지(추출된 것만 순회하면 새 소비처를 영영
//       못 잡는다 — 집합 크기까지 비교).
// AC1 — 실 preset(0376 실물, SSOT=backend/alembic/versions/0376_*.py) × 실 소비처
//       (EventBlockCard·ApprovalRequestCard) 렌더에서 `⟨missing: …⟩` 0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { ChatBubble } from '../src/components/chat/chat-bubble';
import { EventBlockCard } from '../src/components/chat/event-block-card';
import { parseBlockTemplate } from '@/lib/block-template';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import type { EventDefinitionSummary } from '@/lib/block-template';
import koMessages from '../messages/ko.json';
import enMessages from '../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({
    projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member',
    projectMemberships: [],
  }),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-next-image="true" />,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function wrapEn(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="America/Los_Angeles">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const baseMessage: ChatMessage = {
  id: 'msg-3886', memo_id: 'conv-3886', created_by: 'agent-1', sender_name: '오르테가',
  sender_type: 'agent', sender_avatar_url: null, sender_runtime_type: null,
  content: '', attachments: [], created_at: '2026-09-14T00:00:00.000Z',
};

// ============================================================================
// AC2 — renderBlockTemplate( 실 호출부 완전성 자.
// ============================================================================

const SRC_ROOT = path.resolve(__dirname, '../src');
const EXPECTED_CONSUMERS = [
  'components/chat/event-block-card.tsx',
  'components/chat/approval-request-card.tsx',
].sort();

/** src 트리를 훑어 `renderBlockTemplate(` **호출**(정의 자체는 제외)이 있는 비-테스트
 * 파일 경로를 낸다. 정의 라인("export function renderBlockTemplate(")은 `function\s+
 * renderBlockTemplate\s*\(` 패턴으로 걸러 제외 — 정의 파일(lib/block-template.ts)을
 * 하드코딩으로 예외 처리하지 않는다(실제 "호출"만 판별해야 새 소비처가 생겼을 때도
 * 정확히 잡는다). */
function findRenderBlockTemplateConsumers(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      findRenderBlockTemplateConsumers(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
    const content = readFileSync(full, 'utf8');
    const hasCall = content
      .split('\n')
      .some((line) => line.includes('renderBlockTemplate(') && !/function\s+renderBlockTemplate\s*\(/.test(line));
    if (hasCall) out.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
  }
}

describe('story #3886(가드) — preset 블록 템플릿 소비처 완전성(AC2)', () => {
  it('renderBlockTemplate( 실 호출부 집합이 기대 집합과 정확히 일치한다(추출≠기대면 RED — 새 소비처 누락을 잡는다)', () => {
    const found: string[] = [];
    findRenderBlockTemplateConsumers(SRC_ROOT, found);
    expect(found.sort()).toEqual(EXPECTED_CONSUMERS);
  });
});

// ============================================================================
// AC1 — 실 preset(0376 실물) × 실 소비처 렌더에서 ⟨missing: …⟩ 0.
// SSOT: backend/alembic/versions/0376_event_card_target_ref_and_ui_copy_t_namespace.py의
// `_TEMPLATES`. 페드루 CHANGES(2026-09-14 18:27Z) — "TS 상수가 사본이고 drift 자 0"이면
// 0377이 이 두 preset을 또 바꿀 때 이 가드가 옛 템플릿으로 계속 GREEN인(헛도는) 결함이
// 있었다. 처방: 아래에서 실제로 그 .py 파일을 읽어 `_TEMPLATES` 딕셔너리 리터럴을
// 추출·파싱(Python True/False/None→JSON, trailing comma 제거, 문자열 리터럴 안의 `{`/`}`
// (mustache 토큰 "{{...}}")는 상태기계로 건너뛴다)하고, 아래 TS 상수와 `toEqual`로 직접
// 비교한다 — 이 파일이 stale해지면(마이그가 바뀌었는데 TS 상수를 안 고치면) 이 비교
// 자체가 RED가 된다(더 이상 "주석이 자인"이 아니라 코드가 자인).
const BACKEND_ALEMBIC_VERSIONS_DIR = path.resolve(__dirname, '../../../backend/alembic/versions');
const TARGET_MIGRATION_FILE = '0376_event_card_target_ref_and_ui_copy_t_namespace.py';
const PRESET_KEYS = ['preset.work.status_changed', 'preset.gate.verdict'] as const;
// story #3893 — 나머지 2 preset(work.assigned·goal.measured)의 최신 SSOT는 0377(별도
// 파일 — 0376이 다룬 키와 서로소라 두 자가 독립적으로 공존한다, 이 파일이 하나를 고치며
// 다른 하나를 헛돌게 만들지 않는다).
const TARGET_MIGRATION_FILE_0377 = '0377_work_assigned_goal_measured_t_namespace.py';
const PRESET_KEYS_0377 = ['preset.work.assigned', 'preset.goal.measured'] as const;

/** 중괄호 짝을 찾되, 큰따옴표 문자열 리터럴(백슬래시 이스케이프 포함) 안의 `{`/`}`는
 * 세지 않는다 — 이 딕셔너리의 값 자체가 `"{{t.statusChangedHeader}}"`처럼 mustache
 * 토큰을 담고 있어 순진한 카운팅은 문자열 안 중괄호에 오판한다. */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('findMatchingBrace: 짝이 맞는 중괄호를 못 찾음');
}

function pythonDictLiteralToJson(pySrc: string): string {
  return pySrc
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/,(\s*[}\]])/g, '$1'); // Python이 허용하는 trailing comma는 JSON.parse가 거부.
}

function extractTemplatesDict(filePath: string): Record<string, unknown> {
  const src = readFileSync(filePath, 'utf8');
  const marker = '_TEMPLATES: dict[str, dict] = {';
  const markerIdx = src.indexOf(marker);
  if (markerIdx === -1) throw new Error(`${filePath}에서 _TEMPLATES 선언을 못 찾음(마이그 형식이 바뀌었을 수 있음)`);
  const openBraceIdx = markerIdx + marker.length - 1;
  const closeBraceIdx = findMatchingBrace(src, openBraceIdx);
  const jsonText = pythonDictLiteralToJson(src.slice(openBraceIdx, closeBraceIdx + 1));
  return JSON.parse(jsonText) as Record<string, unknown>;
}

const MIGRATED_TEMPLATES = extractTemplatesDict(path.join(BACKEND_ALEMBIC_VERSIONS_DIR, TARGET_MIGRATION_FILE));
const MIGRATED_TEMPLATES_0377 = extractTemplatesDict(path.join(BACKEND_ALEMBIC_VERSIONS_DIR, TARGET_MIGRATION_FILE_0377));

const STATUS_CHANGED_0376 = {
  blocks: [
    { type: 'header', text: '{{t.statusChangedHeader}}' },
    { type: 'text', text: '**{{label.work_item_type}}** `{{label.from_status}}` → `{{label.to_status}}`' },
    { type: 'fields', fields: [
      { label: '{{t.targetLabel}}', value: '{{label.work_item_target}}', optional: true },
      { label: '{{t.noteLabel}}', value: '{{payload.note}}', optional: true },
    ] },
  ],
};
const GATE_VERDICT_0376 = {
  blocks: [
    { type: 'header', text: '{{t.gateVerdictHeader}}' },
    { type: 'text', text: '{{label.gate_connective_line}}' },
    { type: 'fields', fields: [
      { label: '{{t.targetLabel}}', value: '{{label.work_item_target}}', optional: true },
      { label: '{{t.reasonLabel}}', value: '{{payload.resolution_note}}', optional: true },
    ] },
  ],
};

describe('story #3886(가드) — CHANGES(페드루 2026-09-14 18:27Z) TS 미러 drift 자', () => {
  it('TS 상수가 0376 마이그 파일의 _TEMPLATES와 바이트(구조) 동일하다 — 드리프트 시 RED', () => {
    expect(MIGRATED_TEMPLATES['preset.work.status_changed']).toEqual(STATUS_CHANGED_0376);
    expect(MIGRATED_TEMPLATES['preset.gate.verdict']).toEqual(GATE_VERDICT_0376);
  });

  it('0376이 이 두 preset 키를 마지막으로 건드린 마이그레이션이다(더 최신 파일이 같은 키를 또 바꾸면 RED)', () => {
    const files = readdirSync(BACKEND_ALEMBIC_VERSIONS_DIR).filter((f) => /^\d{4}_.*\.py$/.test(f));
    let latest: { file: string; revision: number } | null = null;
    for (const f of files) {
      const revision = Number(f.slice(0, 4));
      const content = readFileSync(path.join(BACKEND_ALEMBIC_VERSIONS_DIR, f), 'utf8');
      const touchesAny = PRESET_KEYS.some((k) => content.includes(`"${k}"`));
      if (!touchesAny) continue;
      if (!latest || revision > latest.revision) latest = { file: f, revision };
    }
    expect(latest?.file).toBe(TARGET_MIGRATION_FILE);
  });
});

// story #3893 — work.assigned/goal.measured의 SSOT(0377) 미러+최신성 자. 0376 자와 완전
// 병렬(대상 키 집합만 다름, 서로 간섭 0).
const WORK_ASSIGNED_0377 = {
  blocks: [
    { type: 'header', text: '{{t.workAssignedHeader}}' },
    { type: 'text', text: '**{{label.work_item_type}}**' },
    { type: 'fields', fields: [
      { label: '{{t.targetLabel}}', value: '{{label.work_item_target}}', optional: true },
      { label: '{{t.assigneeLabel}}', value: '{{label.assignee_name}}', optional: true },
      { label: '{{t.assignedByLabel}}', value: '{{label.assigned_by_name}}', optional: true },
    ] },
  ],
};
const GOAL_MEASURED_0377 = {
  blocks: [
    { type: 'header', text: '{{t.goalMeasuredHeader}}' },
    { type: 'text', text: '{{t.metricValueLabel}} **{{payload.metric_value}}**' },
    { type: 'fields', fields: [
      { label: '{{t.goalLabel}}', value: '{{label.goal_target}}', optional: true },
      { label: '{{t.unitLabel}}', value: '{{label.metric_unit_label}}', optional: true },
      { label: '{{t.sourceLabel}}', value: '{{payload.source}}' },
      { label: '{{t.measuredAtLabel}}', value: '{{label.measured_at}}', optional: true },
    ] },
  ],
};

describe('story #3893(가드) — 0377 TS 미러 drift 자', () => {
  it('TS 상수가 0377 마이그 파일의 _TEMPLATES와 바이트(구조) 동일하다 — 드리프트 시 RED', () => {
    expect(MIGRATED_TEMPLATES_0377['preset.work.assigned']).toEqual(WORK_ASSIGNED_0377);
    expect(MIGRATED_TEMPLATES_0377['preset.goal.measured']).toEqual(GOAL_MEASURED_0377);
  });

  it('0377이 이 두 preset 키를 마지막으로 건드린 마이그레이션이다(더 최신 파일이 같은 키를 또 바꾸면 RED)', () => {
    const files = readdirSync(BACKEND_ALEMBIC_VERSIONS_DIR).filter((f) => /^\d{4}_.*\.py$/.test(f));
    let latest: { file: string; revision: number } | null = null;
    for (const f of files) {
      const revision = Number(f.slice(0, 4));
      const content = readFileSync(path.join(BACKEND_ALEMBIC_VERSIONS_DIR, f), 'utf8');
      const touchesAny = PRESET_KEYS_0377.some((k) => content.includes(`"${k}"`));
      if (!touchesAny) continue;
      if (!latest || revision > latest.revision) latest = { file: f, revision };
    }
    expect(latest?.file).toBe(TARGET_MIGRATION_FILE_0377);
  });
});

function catalogOf(entries: Record<string, unknown>): Record<string, EventDefinitionSummary> {
  const out: Record<string, EventDefinitionSummary> = {};
  for (const [key, block_template] of Object.entries(entries)) {
    out[key] = { key, org_id: null, payload_schema: {}, routing: {}, block_template, enabled: true, version: 1 };
  }
  return out;
}

const EVENT_CATALOG = catalogOf({
  'preset.work.status_changed': STATUS_CHANGED_0376,
  'preset.gate.verdict': GATE_VERDICT_0376,
  'preset.work.assigned': WORK_ASSIGNED_0377,
  'preset.goal.measured': GOAL_MEASURED_0377,
});

function expectNoMissingMarkers(text: string) {
  expect(text).not.toContain('⟨missing');
}

describe('story #3886(가드) — EventBlockCard 실 소비 렌더(AC1)', () => {
  it('status_changed — 찾음(refs.work_item found:true) ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.work.status_changed', sender_type: 'agent',
      event: {
        event_key: 'preset.work.status_changed',
        payload: { work_item_type: 'story', from_status: 'ready-for-dev', to_status: 'in-progress', work_item_id: 'S-1' },
        refs: { work_item: { found: true, token: '[결제 흐름 재설계](entity:story:S-1)' } },
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('status_changed — 못 찾음(found:false) ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.work.status_changed', sender_type: 'agent',
      event: {
        event_key: 'preset.work.status_changed',
        payload: { work_item_type: 'story', from_status: 'ready-for-dev', to_status: 'in-progress', work_item_id: 'S-1' },
        refs: { work_item: { found: false, type: 'story' } },
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('status_changed — 리졸버 없음(refs 키 자체 부재) ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.work.status_changed', sender_type: 'agent',
      event: {
        event_key: 'preset.work.status_changed',
        payload: { work_item_type: 'agent_decision', from_status: 'ready-for-dev', to_status: 'in-progress', work_item_id: 'S-1' },
        refs: {},
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('gate.verdict — 찾음(refs.work_item found:true) ⟨missing⟩ 0, en 로케일', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.gate.verdict', sender_type: 'agent',
      event: {
        event_key: 'preset.gate.verdict',
        payload: { gate_type: 'external_publish', verdict: 'approved', work_item_id: 'S-2' },
        refs: { work_item: { found: true, token: '[결제 흐름 재설계](entity:story:S-2)' } },
      },
    };
    await act(async () => { root.render(wrapEn(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('gate.verdict — 못 찾음(found:false) ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.gate.verdict', sender_type: 'agent',
      event: {
        event_key: 'preset.gate.verdict',
        payload: { gate_type: 'doc_approval', verdict: 'rejected', work_item_id: 'D-1' },
        refs: { work_item: { found: false, type: 'doc' } },
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('gate.verdict — 리졸버 없음(support_escalation, refs 키 자체 부재) ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.gate.verdict', sender_type: 'agent',
      event: {
        event_key: 'preset.gate.verdict',
        payload: { gate_type: 'support_escalation_review', verdict: 'approved', work_item_id: 'E-1' },
        refs: {},
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  // story #3893 — work.assigned/goal.measured(0377). member ref는 work_item과 다른
  // 2모양(found/found:false, 리졸버 자체가 없는 갈래는 없음 — 항상 단일 리졸버).
  it('work.assigned — 담당자·배정자 둘 다 찾음(found:true) ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.work.assigned', sender_type: 'agent',
      event: {
        event_key: 'preset.work.assigned',
        payload: { work_item_type: 'story', work_item_id: 'S-3', assignee_member_id: 'M-1', assigned_by_member_id: 'M-2' },
        refs: {
          work_item: { found: true, token: '[결제 흐름 재설계](entity:story:S-3)' },
          assignee: { found: true, name: '미르코' },
          assigned_by: { found: true, name: '페드루' },
        },
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('work.assigned — 담당자 못 찾음(found:false)·배정자 필드 부재(optional 생략) ⟨missing⟩ 0, en 로케일', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.work.assigned', sender_type: 'agent',
      event: {
        event_key: 'preset.work.assigned',
        payload: { work_item_type: 'task', work_item_id: 'T-1', assignee_member_id: 'M-9' },
        refs: {
          work_item: { found: false, type: 'task' },
          assignee: { found: false },
        },
      },
    };
    await act(async () => { root.render(wrapEn(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  // story #3893 CHANGES①②③(PO PR#4298 리뷰 2026-09-15) — metric_unit은 등재 metric
  // (completion_pct)만 라벨 해석, goal_id는 refs.goal(epic 갈래) 경유, measured_at은
  // formatLocaleDateTime 경유 — 셋 다 payload/refs 파생이라 refs.goal이 있으면 렌더.
  it('goal.measured — 목표(refs.goal found:true)·등재 단위·측정시각 전부 있음 ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.goal.measured', sender_type: 'agent',
      event: {
        event_key: 'preset.goal.measured',
        payload: { goal_id: 'G-1', metric_value: 12, metric_unit: 'completion_pct', source: 'internal_ops', measured_at: '2026-09-14T00:00:00.000Z' },
        refs: { goal: { found: true, token: '[결제 트랙 완주](entity:epic:G-1)' } },
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('goal.measured — 목표 못 찾음(found:false)·미등재 단위(GA4 임의값)·측정시각 부재 전부 optional 생략 ⟨missing⟩ 0, en 로케일', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.goal.measured', sender_type: 'agent',
      event: {
        event_key: 'preset.goal.measured',
        payload: { goal_id: 'G-2', metric_value: 8, metric_unit: 'sessions', source: 'ga4' },
        refs: { goal: { found: false, type: 'epic' } },
      },
    };
    await act(async () => { root.render(wrapEn(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
    expect(container.textContent).not.toContain('sessions');
  });

  it('goal.measured — refs.goal 키 자체 부재(구버전 캐시)도 optional 생략 ⟨missing⟩ 0', async () => {
    const message: ChatMessage = {
      ...baseMessage, content: '[이벤트] preset.goal.measured', sender_type: 'agent',
      event: {
        event_key: 'preset.goal.measured',
        payload: { goal_id: 'G-3', metric_value: 5, source: 'internal_ops' },
        refs: {},
      },
    };
    await act(async () => { root.render(wrap(<ChatBubble message={message} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    expectNoMissingMarkers(container.textContent ?? '');
  });
});

// story #3893 CHANGES④(PO PR#4298 리뷰 2026-09-15) — 조직 이벤트 정의 페이지
// (EventDefinitionSummary, organization/event-definition-summary.tsx)가 `EventBlockCard`
// 를 `refs` 프롭 없이(샘플 payload만) 호출한다는 걸 실측 — 0377의 `preset.work.assigned`
// 초안이 `{{label.assignee_name}}`을 비-optional text 블록에 직접 넣어 이 화면에서
// `⟨missing: label.assignee_name⟩`이 샜다(처방: text 블록을 payload 파생만으로 좁힘).
// 이 자가 그 사고 클래스를 직접 재현·고정한다 — EventBlockCard를 `refs` 완전 생략으로
// 호출(그 페이지와 똑같은 호출 모양)해도 4 preset 전부 ⟨missing⟩ 0이어야 한다.
describe('story #3893(가드) — EventDefinitionSummary와 동형 호출(refs 완전 부재) ⟨missing⟩ 0', () => {
  const SAMPLE_PAYLOADS: Record<string, Record<string, unknown>> = {
    'preset.work.status_changed': { work_item_type: 'story', from_status: 'ready-for-dev', to_status: 'in-progress', work_item_id: '예시 work_item_id', note: '예시 note' },
    'preset.gate.verdict': { gate_type: 'external_publish', verdict: 'approved', work_item_id: '예시 work_item_id', resolution_note: '예시 resolution_note' },
    'preset.work.assigned': { work_item_type: 'story', work_item_id: '예시 work_item_id', assignee_member_id: '예시 assignee_member_id', assigned_by_member_id: '예시 assigned_by_member_id' },
    'preset.goal.measured': { goal_id: '예시 goal_id', metric_value: 0, metric_unit: '예시 metric_unit', source: '예시 source', measured_at: new Date(0).toISOString() },
  };

  for (const [key, template] of Object.entries({
    'preset.work.status_changed': STATUS_CHANGED_0376,
    'preset.gate.verdict': GATE_VERDICT_0376,
    'preset.work.assigned': WORK_ASSIGNED_0377,
    'preset.goal.measured': GOAL_MEASURED_0377,
  })) {
    it(`${key} — refs 프롭 없이(샘플 payload만) 렌더해도 ⟨missing⟩ 0`, async () => {
      const parsed = parseBlockTemplate(template);
      expect(parsed).not.toBeNull();
      await act(async () => {
        root.render(wrap(<EventBlockCard template={parsed!} payload={SAMPLE_PAYLOADS[key]!} />));
      });
      expectNoMissingMarkers(container.textContent ?? '');
    });
  }
});

describe('story #3886(가드) — ApprovalRequestCard(twin 소비처) 실 소비 렌더(AC1)', () => {
  const GATE_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
  const DOC_ID = '22222222-2222-2222-2222-222222222222';
  const approvalMessage: ChatMessage = {
    ...baseMessage, content: "'제안서.md' 문서 결재 요청",
    approval_target: { work_item_type: 'doc', work_item_id: DOC_ID, gate_id: GATE_ID, actions: ['approve', 'reject'] },
  };

  function stubResolvedGate(overrides: Partial<{ status: string; resolution_note: string | null }>) {
    const gate = {
      id: GATE_ID, work_item_id: DOC_ID, work_item_type: 'doc', gate_type: 'external_publish',
      status: overrides.status ?? 'approved', can_approve: true, risk_grade: 'low' as const,
      resolver_id: null, resolved_at: '2026-09-14T00:00:00.000Z',
      resolution_note: overrides.resolution_note ?? null, neutral_facts: null,
      work_item_summary: { title: '제안서.md', slug: null },
      created_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url === `/api/gates/${GATE_ID}`) return { ok: true, json: async () => ({ data: gate }) };
      return { ok: false, json: async () => ({}) };
    }));
  }

  it('resolved(사유 있음) — twin 소비처가 gate_type/verdict/대상/사유를 전부 정확히 해소한다, ⟨missing⟩ 0', async () => {
    stubResolvedGate({ status: 'approved', resolution_note: '근거가 충분합니다' });
    await act(async () => { root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    await act(async () => { await Promise.resolve(); }); // fetchGate 비동기 반영.
    expectNoMissingMarkers(container.textContent ?? '');
  });

  it('resolved(사유 없음, optional 생략) — ⟨missing⟩ 0(fail-loud 마커가 아니라 줄 자체 생략)', async () => {
    stubResolvedGate({ status: 'rejected', resolution_note: null });
    await act(async () => { root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} eventDefinitionsByKey={EVENT_CATALOG} />)); });
    await act(async () => { await Promise.resolve(); });
    expectNoMissingMarkers(container.textContent ?? '');
  });
});
