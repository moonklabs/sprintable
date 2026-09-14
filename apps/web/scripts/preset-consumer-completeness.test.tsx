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
// SSOT: backend/alembic/versions/0376_event_card_target_ref_and_ui_copy_t_namespace.py
// `_TEMPLATES`(2026-09-14 바이트 동일 확認) — 드리프트 시 이 상수도 같이 갱신 필요
// (자동 동기화 없음, 이 파일 자체가 "미갱신"을 잡지는 못한다 — 별도 리스크로 명시).
// ============================================================================

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
