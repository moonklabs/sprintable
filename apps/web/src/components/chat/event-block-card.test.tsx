import { describe, expect, it } from 'vitest';
import { composeEventPreviewLine, type EventPreviewHelpers } from './event-block-card';

// story #3888(§⑤·Chat, PO 확定 2026-09-14 18:19Z) — 대화 목록 미리보기가 이벤트 메시지의
// raw content(발행 시점에 구운 「[이벤트] preset.gate.verdict」류 slug)를 그대로 보여주던
// 것을 헤더+요약 한 줄 조립으로 막는다. 헬퍼는 실 ko.json을 로드하지 않고(순수 함수 단위
// 테스트) 키→값 매핑만 흉내낸다 — gateTypeLabel/gateStatusLabel/entityTypeLabel의 실제
// 키 이름(gate-type-label.ts·gate-status-label.ts·chat-input-entity-tokens.ts)과
// 정확히 맞춰야 진짜 조립 경로를 탄다.
const helpers: EventPreviewHelpers = {
  tBoard: (key) => ({ readyForDev: '개발 대기', inProgress: '진행 중' } as Record<string, string>)[key] ?? key,
  tCage: (key) => ({ gateStatusApproved: '승인됨', gateStatusRejected: '반려됨' } as Record<string, string>)[key] ?? key,
  tDashboard: (key) => ({ ccGateTypeExternalPublish: '외부 발행', ccGateGeneric: '게이트' } as Record<string, string>)[key] ?? key,
  tEventCard: (key) => ({ gateVerdictHeader: '게이트 판정', statusChangedHeader: '작업 상태 변경' } as Record<string, string>)[key] ?? key,
  tEntity: (key) => ({ entityTypeStory: '스토리' } as Record<string, string>)[key] ?? key,
  domainLabels: { statusLabel: () => undefined },
};

describe('composeEventPreviewLine — story #3888', () => {
  it('⭐preset.gate.verdict — 헤더+게이트종류+판정을 "{헤더} · {종류} — {판정}"으로 조립한다(PO 예시와 동형)', () => {
    const line = composeEventPreviewLine(
      'preset.gate.verdict',
      { gate_type: 'external_publish', verdict: 'approved' },
      helpers,
    );
    expect(line).toBe('게이트 판정 · 외부 발행 — 승인됨');
  });

  it('⭐preset.work.status_changed — 헤더+종류+from→to를 "{헤더} · {종류} {from} → {to}"로 조립한다(PO 예시와 동형)', () => {
    const line = composeEventPreviewLine(
      'preset.work.status_changed',
      { work_item_type: 'story', from_status: 'ready-for-dev', to_status: 'in-progress' },
      helpers,
    );
    expect(line).toBe('작업 상태 변경 · 스토리 개발 대기 → 진행 중');
  });

  it('work_item_type이 없으면 종류 라벨 없이 from→to만 붙는다(선택 필드)', () => {
    const line = composeEventPreviewLine(
      'preset.work.status_changed',
      { from_status: 'ready-for-dev', to_status: 'in-progress' },
      helpers,
    );
    expect(line).toBe('작업 상태 변경 · 개발 대기 → 진행 중');
  });

  it('org 커스텀 도메인 라벨(domainLabels.statusLabel)이 있으면 canonical i18n보다 우선한다(기존 3단 폴백과 동형)', () => {
    const overrideHelpers: EventPreviewHelpers = {
      ...helpers,
      domainLabels: { statusLabel: (slug) => (slug === 'ready-for-dev' ? '준비중(커스텀)' : undefined) },
    };
    const line = composeEventPreviewLine(
      'preset.work.status_changed',
      { work_item_type: 'story', from_status: 'ready-for-dev', to_status: 'in-progress' },
      overrideHelpers,
    );
    expect(line).toBe('작업 상태 변경 · 스토리 준비중(커스텀) → 진행 중');
  });

  // 음성대조 — 미지원 event_key·payload 결손은 null(과잉 일반화 금지, 호출부가 기존
  // content 폴백으로 떨어진다는 계약의 근거).
  it('음성대조 — event_key가 없으면 null(호출부가 content로 폴백)', () => {
    expect(composeEventPreviewLine(undefined, { gate_type: 'merge', verdict: 'approved' }, helpers)).toBeNull();
  });

  it('음성대조 — payload가 없으면 null', () => {
    expect(composeEventPreviewLine('preset.gate.verdict', undefined, helpers)).toBeNull();
  });

  it('음성대조 — 미지원 event_key는 null(이 카드가 실측한 2개 preset만 처리, 과잉 일반화 금지)', () => {
    expect(composeEventPreviewLine('preset.some.other', { x: 1 }, helpers)).toBeNull();
  });

  it('음성대조 — preset.gate.verdict인데 gate_type/verdict 중 하나가 없으면 null(반쪽 요약 금지)', () => {
    expect(composeEventPreviewLine('preset.gate.verdict', { gate_type: 'merge' }, helpers)).toBeNull();
    expect(composeEventPreviewLine('preset.gate.verdict', { verdict: 'approved' }, helpers)).toBeNull();
  });

  it('음성대조 — preset.work.status_changed인데 from/to 중 하나가 없으면 null(반쪽 요약 금지)', () => {
    expect(composeEventPreviewLine('preset.work.status_changed', { from_status: 'backlog' }, helpers)).toBeNull();
  });

  // 실 사고 재현(합성 아님) — PO가 실측한 원본 raw content 문자열이 절대 안 새는지
  // 직접 대조(backend/app/routers/events.py::_render_gate_verdict_message의
  // `lines = ["[이벤트] preset.gate.verdict"]`가 만드는 것과 같은 클래스).
  it('실 사고 재현 — 결과 문자열에 "[이벤트]"·"preset." 원시 slug가 전혀 없다', () => {
    const line = composeEventPreviewLine(
      'preset.gate.verdict',
      { gate_type: 'external_publish', verdict: 'approved' },
      helpers,
    )!;
    expect(line).not.toContain('[이벤트]');
    expect(line).not.toContain('preset.');
  });
});
