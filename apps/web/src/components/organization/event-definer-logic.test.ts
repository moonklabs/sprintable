// story #2670(A층) — 폼↔JSON 순수 변환 로직. 서버 검증(backend/app/services/
// event_definition_registry.py)과의 정합이 핵심이라, 그 파일의 실 정규식·routing 2택·
// action_auth 화이트리스트를 여기 회귀가드로 그대로 고정한다(그라운딩 근거는 파일 상단 주석).
import { describe, expect, it } from 'vitest';
import {
  deriveCycle, deriveMeasure, deriveSignal, emptyFormState, makeId,
  slugify, tryReverseParse, validateFieldName, validateKeySuffix,
} from './event-definer-logic';

describe('slugify — R1(서버 _ORG_KEY_RE 접미 문자셋 [a-z0-9_]+, 하이픈 불허)', () => {
  it('영문 이름은 소문자+언더스코어로 정규화한다', () => {
    expect(slugify('Review Requested', 0)).toBe('review_requested');
  });
  it('공백·하이픈 둘 다 언더스코어로 합친다(서버가 하이픈을 거부하므로 슬러그에 남기면 안 됨)', () => {
    expect(slugify('pre-flight check', 0)).toBe('pre_flight_check');
  });
  it('한글 등 비ASCII만 있으면(기계적 의미 번역 불가) stage_N 자리표시자로 폴백한다', () => {
    expect(slugify('초안 작성', 0)).toBe('stage_1');
    expect(slugify('검토 요청', 2)).toBe('stage_3');
  });
  it('빈 문자열도 폴백한다', () => {
    expect(slugify('   ', 4)).toBe('stage_5');
  });
});

describe('validateKeySuffix — #2666 클라 선검증(서버 _ORG_KEY_RE 접미 세그먼트와 동일 문자셋)', () => {
  it('유효한 접미는 통과(null)', () => {
    expect(validateKeySuffix('release_flow')).toBeNull();
    expect(validateKeySuffix('work.gate_cycle')).toBeNull();
  });
  it('빈 값은 empty', () => {
    expect(validateKeySuffix('')).toBe('empty');
    expect(validateKeySuffix('   ')).toBe('empty');
  });
  // #43201862 오진 방지 — 문자셋 위반은 charset이지 empty가 아니어야 한다(원인을 정확히 짚음).
  it('하이픈·대문자 등 문자셋 위반은 charset(빈 값과 다른 원인으로 갈린다)', () => {
    expect(validateKeySuffix('release-flow')).toBe('charset');
    expect(validateKeySuffix('Release_Flow')).toBe('charset');
    expect(validateKeySuffix('release flow')).toBe('charset');
  });
});

describe('validateFieldName', () => {
  it('[a-z0-9_]만 허용(block-template.ts MUSTACHE_RE와 동일 문자셋 — 안 맞으면 {{payload.x}} 치환이 안 됨)', () => {
    expect(validateFieldName('pr_number')).toBe(true);
    expect(validateFieldName('pr-number')).toBe(false);
    expect(validateFieldName('PR_Number')).toBe(false);
  });
});

describe('deriveCycle — 서식① (핸드오프 스펙 §2 사이클형 예시와 대조)', () => {
  it('단계 목록 → payload_schema.properties.stage.enum, routing 2택·escalation 항상 포함(R3)', () => {
    const state = emptyFormState('cycle');
    state.name = '릴리즈 준비 흐름';
    state.keySuffix = 'release_flow';
    state.stages = [
      { id: makeId(), name: '초안 작성', slug: 'draft' },
      { id: makeId(), name: '검토 요청', slug: 'review_requested' },
      { id: makeId(), name: '승인됨', slug: 'approved' },
      { id: makeId(), name: '배포됨', slug: 'deployed' },
    ];
    state.fields = [
      { id: makeId(), name: 'release_note', type: 'string', required: true },
      { id: makeId(), name: 'pr_number', type: 'number', required: false },
    ];
    state.humanOnly = true;
    state.rolesCsv = 'owner, admin';

    const d = deriveCycle(state, 'moonklabs');
    expect(d.key).toBe('org.moonklabs.release_flow');
    expect(d.payload_schema).toEqual({
      type: 'object',
      properties: {
        stage: { type: 'string', enum: ['draft', 'review_requested', 'approved', 'deployed'] },
        release_note: { type: 'string' },
        pr_number: { type: 'number' },
      },
      required: ['stage', 'release_note'],
      additionalProperties: false,
    });
    // R4 — 기본(발행할 때 지정) = payload_field. R3 — escalation은 항상 명시(server_derived·none).
    expect(d.routing).toEqual({
      escalation: { kind: 'server_derived', target: 'none' },
      broadcast: { kind: 'payload_field', member_id_field: 'assignee_member_id' },
    });
    // R2 — role은 action_auth.role(⛔allowed_roles 아님).
    expect(d.action_auth).toEqual({ human_only: true, role: ['owner', 'admin'] });
    expect(d.block_template.blocks[0]).toEqual({ type: 'header', text: '릴리즈 준비 흐름' });
    expect(d.samplePayload.stage).toBe('deployed'); // 마지막 단계로 미리보기(가장 정보량 많은 상태).
  });

  it('기록만(record_only) 선택 시 broadcast도 server_derived·target=none', () => {
    const state = emptyFormState('cycle');
    state.keySuffix = 'x';
    state.stages = [{ id: makeId(), name: 'a', slug: 'a' }];
    state.routing = 'record_only';
    const d = deriveCycle(state, 'moonklabs');
    expect(d.routing.broadcast).toEqual({ kind: 'server_derived', target: 'none' });
  });

  it('human_only도 role도 없으면 action_auth는 null(불필요한 빈 객체를 안 보냄)', () => {
    const state = emptyFormState('cycle');
    state.keySuffix = 'x';
    state.stages = [{ id: makeId(), name: 'a', slug: 'a' }];
    const d = deriveCycle(state, 'moonklabs');
    expect(d.action_auth).toBeNull();
  });

  it('문자셋 위반 필드명(예: 하이픈)은 payload_schema·block_template 양쪽에서 조용히 제외한다(서버 400 재생산 방지)', () => {
    const state = emptyFormState('cycle');
    state.keySuffix = 'x';
    state.stages = [{ id: makeId(), name: 'a', slug: 'a' }];
    state.fields = [{ id: makeId(), name: 'bad-name', type: 'string', required: false }];
    const d = deriveCycle(state, 'moonklabs');
    expect(d.payload_schema.properties).not.toHaveProperty('bad-name');
  });
});

describe('deriveSignal — 서식②', () => {
  it('kind enum + summary 토글 → payload_schema', () => {
    const state = emptyFormState('signal');
    state.keySuffix = 'x';
    state.signalKinds = ['verdict', 'scope'];
    state.includeSummary = true;
    const d = deriveSignal(state, 'moonklabs');
    expect(d.payload_schema.properties).toMatchObject({
      kind: { type: 'string', enum: ['verdict', 'scope'] },
      summary: { type: 'string' },
    });
    expect(d.payload_schema.required).toEqual(['kind']);
  });

  it('summary 미포함 시 properties에도 없다(지어내지 않음)', () => {
    const state = emptyFormState('signal');
    state.keySuffix = 'x';
    state.signalKinds = ['verdict'];
    state.includeSummary = false;
    const d = deriveSignal(state, 'moonklabs');
    expect(d.payload_schema.properties).not.toHaveProperty('summary');
  });
});

describe('deriveMeasure — 서식③', () => {
  it('metric_value 필수 + unit/source 토글', () => {
    const state = emptyFormState('measure');
    state.keySuffix = 'x';
    state.includeMetricUnit = true;
    state.includeSource = false;
    const d = deriveMeasure(state, 'moonklabs');
    expect(d.payload_schema.properties).toMatchObject({ metric_value: { type: 'number' }, metric_unit: { type: 'string' } });
    expect(d.payload_schema.properties).not.toHaveProperty('source');
    expect(d.payload_schema.required).toEqual(['metric_value']);
  });
});

describe('tryReverseParse — AC3 JSON→폼 왕복(표현 가능 범위만, 못 하면 null="고급 전용")', () => {
  it('deriveCycle 결과를 그대로 되돌리면(자기 왕복) 동일 폼 상태로 복원된다', () => {
    const state = emptyFormState('cycle');
    state.name = '릴리즈';
    state.keySuffix = 'release_flow';
    state.stages = [{ id: makeId(), name: '초안', slug: 'draft' }, { id: makeId(), name: '완료', slug: 'done' }];
    state.fields = [{ id: makeId(), name: 'note', type: 'string', required: true }];
    state.humanOnly = true;
    state.rolesCsv = 'owner';
    const d = deriveCycle(state, 'moonklabs');

    const parsed = tryReverseParse(d.key, d.payload_schema, d.routing, d.action_auth, 'moonklabs');
    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('cycle');
    expect(parsed!.keySuffix).toBe('release_flow');
    expect(parsed!.stages.map((s) => s.slug)).toEqual(['draft', 'done']);
    expect(parsed!.fields).toEqual([{ id: expect.any(String), name: 'note', type: 'string', required: true }]);
    expect(parsed!.humanOnly).toBe(true);
    expect(parsed!.rolesCsv).toBe('owner');
    expect(parsed!.routing).toBe('assign_on_publish');
  });

  it('deriveSignal/deriveMeasure도 자기 왕복된다', () => {
    const sigState = emptyFormState('signal');
    sigState.keySuffix = 'sig'; sigState.signalKinds = ['a', 'b']; sigState.includeSummary = true;
    const sig = deriveSignal(sigState, 'moonklabs');
    const parsedSig = tryReverseParse(sig.key, sig.payload_schema, sig.routing, sig.action_auth, 'moonklabs');
    expect(parsedSig?.format).toBe('signal');
    expect(parsedSig?.signalKinds).toEqual(['a', 'b']);

    const measState = emptyFormState('measure');
    measState.keySuffix = 'meas'; measState.includeMetricUnit = true; measState.includeSource = true;
    const meas = deriveMeasure(measState, 'moonklabs');
    const parsedMeas = tryReverseParse(meas.key, meas.payload_schema, meas.routing, meas.action_auth, 'moonklabs');
    expect(parsedMeas?.format).toBe('measure');
    expect(parsedMeas?.includeMetricUnit).toBe(true);
    expect(parsedMeas?.includeSource).toBe(true);
  });

  it('routing이 폼이 못 만드는 모양(server_derived target=work_item_stakeholders)이면 null(고급 전용)', () => {
    const parsed = tryReverseParse(
      'org.moonklabs.x',
      { properties: { stage: { type: 'string', enum: ['a'] } }, required: ['stage'] },
      { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'work_item_stakeholders' } },
      null,
      'moonklabs',
    );
    expect(parsed).toBeNull();
  });

  it('action_auth에 v1 화이트리스트 밖 키가 있으면 null(고급 전용)', () => {
    const parsed = tryReverseParse(
      'org.moonklabs.x',
      { properties: { kind: { type: 'string', enum: ['a'] } }, required: ['kind'] },
      { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } },
      { human_only: true, extra_unknown_key: 'x' },
      'moonklabs',
    );
    expect(parsed).toBeNull();
  });

  it('키가 다른 org 접두면 null(도용 케이스가 아니라, 단순히 이 화면 스코프 밖)', () => {
    const parsed = tryReverseParse(
      'org.other-org.x',
      { properties: { kind: { type: 'string', enum: ['a'] } }, required: ['kind'] },
      { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } },
      null,
      'moonklabs',
    );
    expect(parsed).toBeNull();
  });

  it('필드가 3서식 어디에도 안 걸리는 모양(stage/kind/metric_value 전부 없음)이면 null', () => {
    const parsed = tryReverseParse(
      'org.moonklabs.x',
      { properties: { something_else: { type: 'string' } }, required: [] },
      { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } },
      null,
      'moonklabs',
    );
    expect(parsed).toBeNull();
  });
});
