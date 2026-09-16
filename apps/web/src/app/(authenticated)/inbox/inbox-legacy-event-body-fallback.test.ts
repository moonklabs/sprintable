import { describe, expect, it } from 'vitest';
import type { EventPreviewHelpers } from '@/components/chat/event-block-card';
import { composeLegacyEventBodyFallback, composeNotificationDisplay, type Notification } from './inbox-notification-display';

// story #3940(PO 라이브 재잼 2026-09-16) — 2026-09-15 前(migration 0378 前) dispatch된
// 알림은 event가 없어 composeEventPreviewLine을 못 타고, BE가 그 시절 저장한 body 원문이
// raw preset 키·마크다운 이스케이프·entity: 링크 안 UUID까지 그대로 노출됐다. 아래 3개
// fixture는 실 dev-app PO Test Org API(/api/notifications?limit=50, 2026-09-16 재실측)에서
// 그대로 가져온 실 레코드 body 원문이다(합성 표본 아님, memory
// feedback_a_ui_fixs_synthetic_test_fixture 위반 회피).
const REAL_LEGACY_BODY_NESTED_BRACKETS =
  '[이벤트] preset.gate.verdict\n- work item: [\\[Phase1 판정·픽스처\\] connection 칸 — 토큰 만료](entity:story:d08866c5-aa34-42e0-9089-458a1a5b4660)\n- 게이트: external_publish → approved\n- gate_id: 66f4bbed-7982-48fd-934a';
const REAL_LEGACY_BODY_ESCAPED_PARENS =
  '[이벤트] preset.gate.verdict\n- work item: [프로브 스토리 B\\(카드 검증\\)](entity:story:90756e07-2254-4ed8-83fd-6f84c1fb8cf9)\n- 게이트: external_publish → approved\n- gate_id: 88a9423b-9e4f-4650-a989-b092827e698b\n- 사유: ';
const REAL_LEGACY_BODY_MIXED_BRACKETS_AND_PARENS =
  '[이벤트] preset.gate.verdict\n- work item: [\\[SMOKE·삭제예정\\] 3620 D0 마커 발행\\(insight-drift\\) — 불일치 표본](entity:story:ea73b2bd-8323-414e-a7e6-ba4ffa90b5c2)\n- 게이트: external_publish → approved\n- gate_id: 5341730';

const helpers: EventPreviewHelpers = {
  tBoard: (key) => key,
  tCage: (key) => key,
  tDashboard: (key) => key,
  tEventCard: (key) => ({ gateVerdictHeader: '게이트 판정' } as Record<string, string>)[key] ?? key,
  tEntity: (key) => key,
  tOutcomeLoop: (key) => key,
  domainLabels: { statusLabel: () => undefined },
};

describe('composeLegacyEventBodyFallback — story #3940(실 레코드 fixture 3)', () => {
  it('중첩 대괄호 제목 — 헤더+라벨만 남기고 preset 키·entity 링크·UUID 전부 걷는다', () => {
    const line = composeLegacyEventBodyFallback(REAL_LEGACY_BODY_NESTED_BRACKETS, helpers.tEventCard);
    expect(line).toBe('게이트 판정 · [Phase1 판정·픽스처] connection 칸 — 토큰 만료');
    expect(line).not.toContain('preset.');
    expect(line).not.toContain('entity:');
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('이스케이프된 괄호 제목 — 백슬래시만 벗기고 라벨 원문 보존', () => {
    const line = composeLegacyEventBodyFallback(REAL_LEGACY_BODY_ESCAPED_PARENS, helpers.tEventCard);
    expect(line).toBe('게이트 판정 · 프로브 스토리 B(카드 검증)');
  });

  it('대괄호+괄호 혼합 이스케이프 제목 — 둘 다 정확히 벗긴다', () => {
    const line = composeLegacyEventBodyFallback(REAL_LEGACY_BODY_MIXED_BRACKETS_AND_PARENS, helpers.tEventCard);
    expect(line).toBe('게이트 판정 · [SMOKE·삭제예정] 3620 D0 마커 발행(insight-drift) — 불일치 표본');
  });

  it('양성대조 — legacy 모양이 아닌 body는 null(호출부가 기존 title/body로 폴백)', () => {
    expect(composeLegacyEventBodyFallback('그냥 평문 알림입니다', helpers.tEventCard)).toBeNull();
    expect(composeLegacyEventBodyFallback(null, helpers.tEventCard)).toBeNull();
  });

  it('미등재 preset 키는 헤더 없이 라벨만(신규 어간 발명 0)', () => {
    const body = '[이벤트] preset.unknown.thing\n- work item: [제목](entity:story:d08866c5-aa34-42e0-9089-458a1a5b4660)';
    expect(composeLegacyEventBodyFallback(body, helpers.tEventCard)).toBe('제목');
  });
});

function baseNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1', type: 'conversation.message', title: '시스템 발행님의 새 메시지',
    body: null, is_read: false, reference_type: 'conversation', reference_id: 'r1',
    event: null, created_at: '2026-09-13T00:09:27.992393Z',
    ...overrides,
  };
}

describe('composeNotificationDisplay — event 없는 legacy 레코드 폴백 배선', () => {
  it('event 없고 legacy 모양 body면 폴백 적용', () => {
    const { body } = composeNotificationDisplay(
      baseNotification({ body: REAL_LEGACY_BODY_NESTED_BRACKETS }),
      (key: string) => key,
      helpers,
    );
    expect(body).toBe('게이트 판정 · [Phase1 판정·픽스처] connection 칸 — 토큰 만료');
  });

  // story #3903 AC2 no-op 유지 — event 있는 새 레코드 경로는 이 카드가 손대지 않는다.
  it('event 있으면 legacy 폴백은 안 타고 기존 composeEventPreviewLine 경로 그대로(no-op)', () => {
    const { body } = composeNotificationDisplay(
      baseNotification({
        body: REAL_LEGACY_BODY_NESTED_BRACKETS, // event가 있으면 이 body는 아예 안 봄
        event: { event_key: 'preset.gate.verdict', payload: { gate_type: 'external_publish', verdict: 'approved' } },
      }),
      (key: string) => key,
      helpers,
    );
    expect(body).not.toContain('토큰 만료'); // legacy body 라벨이 새지 않는다
  });

  // story #3940 실사고(카디르 QA 적발, PR#4344 codex 뮤테이션 6건 中 5건 발산) — event가
  // 있지만 event_key가 없는 gate.pending_approval은 원래 `else`(현재 `else if (event ==
  // null)`)로 떨어져 방금 gatePendingApprovalBody로 정상 조합한 body를 legacy 파싱이
  // 다시 덮어썼다. notification.body가 우연히 legacy 패턴과 겹치는 실사고 재현으로 고정.
  it('gate.pending_approval(event 有·event_key 無)은 legacy 폴백에 덮이지 않는다(카디르 QA 적발 회귀)', () => {
    const { title, body } = composeNotificationDisplay(
      baseNotification({
        type: 'gate.pending_approval',
        body: REAL_LEGACY_BODY_NESTED_BRACKETS, // BE raw body가 우연히 legacy 패턴과 일치해도
        event: { payload: { gate_type: 'external_publish' } }, // event_key 없음(이 preset 계약)
      }),
      (key: string, values?: Record<string, string | number>) =>
        key === 'gatePendingApprovalTitle' ? '결재 대기'
        : key === 'gatePendingApprovalBody' ? `${values?.['gateType']} 게이트 결재 대기`
        : key,
      helpers,
    );
    expect(title).toBe('결재 대기');
    expect(body).toBe('ccGateTypeExternalPublish 게이트 결재 대기'); // tDashboard 스텁=항등, gateTypeLabel이 그 매핑키를 넘김
    expect(body).not.toContain('토큰 만료'); // legacy 라벨이 덮어쓰지 않는다
  });
});

// story #3949(E-UX-OVERHAUL·customer-zero·§①) — event도 없고 legacy「[이벤트] preset.X」
// 패턴과도 안 맞는(=«보통» conversation.message가 event 페이로드 없이 도착) body는 위
// 두 분기 다 안 걸려 raw notification.body 그대로 반환됐다 — 마크다운 링크/entity 참조
// 토큰이 그대로 샐 수 있다. 실 레코드 fixture = PO 라이브 실측(b676dc29·대화 6a584f3e)
// 원문 형태 재현(chat-list-view.test.tsx·entity-backlinks-section.test.tsx와 동일 원문).
describe('composeNotificationDisplay — story #3949 평문화(event 無·legacy 패턴도 無)', () => {
  it('⭐entity 참조 토큰이 든 일반 메시지 body는 라벨만 남는다', () => {
    const { body } = composeNotificationDisplay(
      baseNotification({
        body: '[PO 픽스처 2·삭제예정] 같은 org 산출물 참조 [\\[PO 픽스처 산출물…\\]]'
          + '(entity:artifact:c92d9614-1111-2222-3333-444455556666)',
      }),
      (key: string) => key,
      helpers,
    );
    expect(body).toBe('[PO 픽스처 2·삭제예정] 같은 org 산출물 참조 [PO 픽스처 산출물…]');
    expect(body).not.toContain('entity:artifact:');
    expect(body).not.toContain('](');
  });

  it('음성대조 — 마크다운 문법이 없는 평범한 body는 무변', () => {
    const { body } = composeNotificationDisplay(
      baseNotification({ body: '오늘 배포 몇 시예요?' }),
      (key: string) => key,
      helpers,
    );
    expect(body).toBe('오늘 배포 몇 시예요?');
  });

  it('무관 no-op — event로 이미 조합된 body(entity 문법 없음)는 그대로', () => {
    const { body } = composeNotificationDisplay(
      baseNotification({
        body: '[이벤트] preset.gate.verdict',
        event: { event_key: 'preset.gate.verdict', payload: { gate_type: 'external_publish', verdict: 'approved' } },
      }),
      (key: string) => key,
      helpers,
    );
    expect(body).not.toBeNull();
    expect(body).not.toContain('entity:');
  });
});
