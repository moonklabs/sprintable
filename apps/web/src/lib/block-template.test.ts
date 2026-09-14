import { describe, expect, it } from 'vitest';
import { parseBlockTemplate, renderBlockTemplate, substituteMustache, isKnownBlockType } from './block-template';

// story #2637 AC0-b — 스토리 AC 본문의 실물 JSON 그대로(SSOT, 서술 재구성 금지 확認 완료).
const AC0B_EXAMPLE = {
  blocks: [
    { type: 'header', text: '작업 상태 변경' },
    { type: 'text', text: '**{{payload.work_item_type}}** `{{payload.from_status}}` → `{{payload.to_status}}`' },
    {
      type: 'fields',
      fields: [
        { label: '대상', value: '{{payload.work_item_id}}' },
        { label: '메모', value: '{{payload.note}}' },
      ],
    },
    {
      type: 'actions',
      actions: [{ label: '확認', action: 'publish', definition_key: '<발행할 key>', auth: { human_only: true } }],
    },
  ],
};

describe('isKnownBlockType — story #2637 AC1 (어휘 4종 밖 거부)', () => {
  it('4종 전부 known', () => {
    expect(isKnownBlockType('header')).toBe(true);
    expect(isKnownBlockType('text')).toBe(true);
    expect(isKnownBlockType('fields')).toBe(true);
    expect(isKnownBlockType('actions')).toBe(true);
  });

  it('어휘 밖 타입은 unknown', () => {
    expect(isKnownBlockType('image')).toBe(false);
    expect(isKnownBlockType('divider')).toBe(false);
    expect(isKnownBlockType('')).toBe(false);
  });
});

describe('substituteMustache — story #2637 AC0-b', () => {
  it('단일 토큰 치환', () => {
    expect(substituteMustache('상태: {{payload.status}}', { status: 'approved' })).toBe('상태: approved');
  });

  it('한 문자열 안 다중 토큰 치환', () => {
    expect(substituteMustache('{{payload.from}} → {{payload.to}}', { from: 'pending', to: 'done' })).toBe('pending → done');
  });

  it('치환 실패(키 부재)는 빈 문자열이 아니라 명시 플레이스홀더', () => {
    expect(substituteMustache('메모: {{payload.note}}', {})).toBe('메모: ⟨missing: payload.note⟩');
  });

  it('치환 실패(값이 null/undefined)도 명시 플레이스홀더', () => {
    expect(substituteMustache('{{payload.note}}', { note: null })).toBe('⟨missing: payload.note⟩');
    expect(substituteMustache('{{payload.note}}', { note: undefined })).toBe('⟨missing: payload.note⟩');
  });

  it('문자열 아닌 값(숫자·불리언)은 직렬화해 치환', () => {
    expect(substituteMustache('{{payload.count}}', { count: 3 })).toBe('3');
    expect(substituteMustache('{{payload.flag}}', { flag: false })).toBe('false');
  });

  it('토큰이 없는 문자열은 그대로', () => {
    expect(substituteMustache('그냥 텍스트', { x: 1 })).toBe('그냥 텍스트');
  });

  it('payload 네임스페이스 밖 머스태시(오타 등)는 치환 대상이 아니다', () => {
    expect(substituteMustache('{{other.field}}', { field: 'x' })).toBe('{{other.field}}');
  });
});

describe('substituteMustache — story #3332 {{ref.X}} 네임스페이스', () => {
  it('ref 값이 있으면 그대로 치환(클릭 토큰 문자열)', () => {
    expect(substituteMustache('대상: {{ref.work_item}}', {}, { work_item: '[제목](entity:story:abc)' }))
      .toBe('대상: [제목](entity:story:abc)');
  });

  it('refs 인자를 생략하면(기존 2-인자 호출부) ref 머스태시는 명시 플레이스홀더', () => {
    expect(substituteMustache('{{ref.work_item}}', {})).toBe('⟨missing: ref.work_item⟩');
  });

  it('refs에 키가 없거나 값이 null이면 명시 플레이스홀더(payload와 동일 원칙)', () => {
    expect(substituteMustache('{{ref.work_item}}', {}, {})).toBe('⟨missing: ref.work_item⟩');
    expect(substituteMustache('{{ref.work_item}}', {}, { work_item: null })).toBe('⟨missing: ref.work_item⟩');
  });

  it('payload와 ref 두 네임스페이스가 한 문자열에 섞여도 각자 정확히 치환', () => {
    expect(substituteMustache('{{payload.verdict}} · {{ref.work_item}}', { verdict: 'approved' }, { work_item: '[제목](entity:story:abc)' }))
      .toBe('approved · [제목](entity:story:abc)');
  });
});

describe('substituteMustache — story #3881 {{label.X}} 네임스페이스', () => {
  it('label 값이 있으면 그대로 치환(호출부가 발행 시점 아니라 렌더 시점에 계산한 라벨)', () => {
    expect(substituteMustache('상태: {{label.from_status}}', {}, {}, { from_status: '개발 대기' }))
      .toBe('상태: 개발 대기');
  });

  it('labels 인자를 생략하면(기존 3-인자 이하 호출부) label 머스태시는 명시 플레이스홀더', () => {
    expect(substituteMustache('{{label.from_status}}', {})).toBe('⟨missing: label.from_status⟩');
  });

  it('labels에 키가 없으면 명시 플레이스홀더(payload/ref와 동일 원칙)', () => {
    expect(substituteMustache('{{label.from_status}}', {}, {}, {})).toBe('⟨missing: label.from_status⟩');
  });

  it('payload·ref·label 세 네임스페이스가 한 문자열에 섞여도 각자 정확히 치환', () => {
    expect(substituteMustache(
      '{{payload.work_item_type}} `{{label.from_status}}` → `{{label.to_status}}` {{ref.work_item}}',
      { work_item_type: 'story' },
      { work_item: '[제목](entity:story:abc)' },
      { from_status: '개발 대기', to_status: '진행 중' },
    )).toBe('story `개발 대기` → `진행 중` [제목](entity:story:abc)');
  });
});

describe('renderBlockTemplate — story #3881 AC2/AC3 (label 치환 + optional 필드 생략)', () => {
  // story #3881 실 사고 재현: 0249가 심은 실제 preset.work.status_changed 문구(migration
  // 0375 적용 後 형태 — {{payload.X}}→{{label.X}}, note는 optional: true). 페드루
  // CHANGES(2026-09-14 15:26Z, AC5 캡처 리뷰 中 실측 적출) — work_item_type도 원시
  // slug("story")였다(AC2 "slug 0"과 동일 클래스, 최초 그라운딩이 놓침) → label 네임스페이스로.
  const STATUS_CHANGED_TEMPLATE = {
    blocks: [
      { type: 'header', text: '작업 상태 변경' },
      { type: 'text', text: '**{{label.work_item_type}}** `{{label.from_status}}` → `{{label.to_status}}`' },
      {
        type: 'fields',
        fields: [
          { label: '대상', value: '{{payload.work_item_id}}' },
          { label: '메모', value: '{{payload.note}}', optional: true },
        ],
      },
    ],
  };

  it('AC2 — work_item_type/from_status/to_status가 전부 라벨로 치환된다(원시 slug 0)', () => {
    const template = parseBlockTemplate(STATUS_CHANGED_TEMPLATE)!;
    const payload = { work_item_type: 'story', work_item_id: 'S-123' };
    const labels = { work_item_type: '스토리', from_status: '개발 대기', to_status: '진행 중' };
    const rendered = renderBlockTemplate(template, payload, {}, labels);
    expect(rendered[1]).toEqual({ type: 'text', text: '**스토리** `개발 대기` → `진행 중`' });
  });

  it('AC3 — note가 payload에 없고 optional:true면 그 field entry 자체가 배열에서 빠진다(⟨missing⟩ 노출 0)', () => {
    const template = parseBlockTemplate(STATUS_CHANGED_TEMPLATE)!;
    const payload = { work_item_type: 'story', work_item_id: 'S-123' };
    const labels = { work_item_type: '스토리', from_status: '개발 대기', to_status: '진행 중' };
    const rendered = renderBlockTemplate(template, payload, {}, labels);
    expect(rendered[2]).toEqual({
      type: 'fields',
      fields: [{ label: '대상', value: 'S-123' }], // 「메모」 entry 자체가 없다 — placeholder 아님.
    });
  });

  it('AC3 양성대조 — note에 실 값이 있으면 optional:true여도 그대로 렌더된다(과잉 생략 아님)', () => {
    const template = parseBlockTemplate(STATUS_CHANGED_TEMPLATE)!;
    const payload = { work_item_type: 'story', work_item_id: 'S-123', note: '재작업 필요' };
    const labels = { work_item_type: '스토리', from_status: '개발 대기', to_status: '진행 중' };
    const rendered = renderBlockTemplate(template, payload, {}, labels);
    expect(rendered[2]).toEqual({
      type: 'fields',
      fields: [
        { label: '대상', value: 'S-123' },
        { label: '메모', value: '재작업 필요' },
      ],
    });
  });

  it('AC3 양성대조(필수 필드 유지) — optional 미지정 필드는 값이 없으면 여전히 fail-loud(⟨missing⟩) — 회귀 0', () => {
    const template = parseBlockTemplate(STATUS_CHANGED_TEMPLATE)!;
    // work_item_id(optional 미지정 — 필수)가 없는 경우 — fields 배열에서 안 빠지고 그대로
    // 플레이스홀더. note(optional:true)는 값이 있어 이 테스트의 관심사(필수 축)와 분리한다.
    const payload = { work_item_type: 'story', note: '재작업 필요' };
    const rendered = renderBlockTemplate(template, payload, {}, { from_status: '개발 대기', to_status: '진행 중' });
    expect(rendered[2]).toEqual({
      type: 'fields',
      fields: [
        { label: '대상', value: '⟨missing: payload.work_item_id⟩' },
        { label: '메모', value: '재작업 필요' },
      ],
    });
  });

  it('story #3881 0375 마이그 실 예시(preset.gate.verdict) — gate_type/verdict 라벨 치환 + resolution_note 줄 생략', () => {
    // migration 0375_status_changed_verdict_optional_fields.py의 실물 JSON 그대로(SSOT,
    // 서술 재구성 금지 확認 완료). 페드루 CHANGES(2026-09-14 15:26Z) — gate_type도
    // work_item_type과 같은 클래스라 label 네임스페이스로.
    const template = parseBlockTemplate({
      blocks: [
        { type: 'header', text: '게이트 판정' },
        { type: 'text', text: '**{{label.gate_type}}** 게이트 — **{{label.verdict}}**' },
        {
          type: 'fields',
          fields: [
            { label: '대상', value: '{{payload.work_item_id}}' },
            { label: '사유', value: '{{payload.resolution_note}}', optional: true },
          ],
        },
      ],
    })!;
    // gate_service.py:2169-2174가 유일 publisher — resolution_note를 payload에 아예 안 싣는다.
    const payload = { gate_type: 'external_publish', work_item_id: 'S-1' };
    // gateTypeLabel(dashboard.ccGateTypeExternalPublish)·gateStatusLabel(cage.gateStatusApproved) 재사용.
    const labels = { gate_type: '외부 발행', verdict: '승인됨' };
    const rendered = renderBlockTemplate(template, payload, {}, labels);

    expect(rendered[1]).toEqual({ type: 'text', text: '**외부 발행** 게이트 — **승인됨**' });
    expect(rendered[2]).toEqual({ type: 'fields', fields: [{ label: '대상', value: 'S-1' }] }); // 「사유」 없음
  });

  it('optional:true여도 값이 정적 텍스트와 섞여 있으면(단일 토큰 아님) 생략 대상이 아니다(지어내기 방지)', () => {
    const template = parseBlockTemplate({
      blocks: [{
        type: 'fields',
        fields: [{ label: '메모', value: '메모: {{payload.note}}', optional: true }],
      }],
    })!;
    const rendered = renderBlockTemplate(template, {});
    expect(rendered[0]).toEqual({
      type: 'fields',
      fields: [{ label: '메모', value: '메모: ⟨missing: payload.note⟩' }],
    });
  });

  it('labels 인자를 생략해도(구버전 호출부) label 없는 템플릿은 회귀 0', () => {
    const template = parseBlockTemplate({
      blocks: [{ type: 'fields', fields: [{ label: '대상', value: '{{payload.work_item_id}}' }] }],
    })!;
    const payload = { work_item_id: 'S-1' };
    expect(renderBlockTemplate(template, payload)).toEqual(renderBlockTemplate(template, payload, {}, {}));
  });
});

describe('parseBlockTemplate — story #3881 AC3 optional 필드 파싱', () => {
  it('optional: true를 파싱해 field entry에 보존한다', () => {
    const parsed = parseBlockTemplate({
      blocks: [{ type: 'fields', fields: [{ label: '메모', value: '{{payload.note}}', optional: true }] }],
    });
    expect(parsed!.blocks[0]).toEqual({
      type: 'fields',
      fields: [{ label: '메모', value: '{{payload.note}}', optional: true }],
    });
  });

  it('optional 생략은 undefined로 남는다(키 자체가 안 생김 — 기존 fail-loud 하위호환)', () => {
    const parsed = parseBlockTemplate({
      blocks: [{ type: 'fields', fields: [{ label: '대상', value: '{{payload.work_item_id}}' }] }],
    });
    // toEqual은 여분 키 존재를 오탐 없이 정확히 판별한다 — {label, value} 딱 그 shape이면
    // optional 키 자체가 안 생겼다는 뜻(있었다면 이 assert가 실패했을 것).
    expect(parsed!.blocks[0]).toEqual({
      type: 'fields',
      fields: [{ label: '대상', value: '{{payload.work_item_id}}' }],
    });
  });

  it('optional이 boolean이 아니면(어휘 오염) 전체 null(AC1 부분 통과 없음 원칙과 동형)', () => {
    expect(parseBlockTemplate({
      blocks: [{ type: 'fields', fields: [{ label: 'x', value: 'y', optional: 'yes' }] }],
    })).toBeNull();
  });
});

describe('parseBlockTemplate — story #2637 AC0-b 실물', () => {
  it('AC0-b 실 예시를 그대로 파싱한다', () => {
    const parsed = parseBlockTemplate(AC0B_EXAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.blocks).toHaveLength(4);
    expect(parsed!.blocks[0]).toEqual({ type: 'header', text: '작업 상태 변경' });
  });

  it('blocks가 배열이 아니면 null', () => {
    expect(parseBlockTemplate({ blocks: 'not-array' })).toBeNull();
  });

  it('blocks 키 자체가 없으면 null', () => {
    expect(parseBlockTemplate({})).toBeNull();
  });

  it('원시값(문자열·숫자·null)이면 null', () => {
    expect(parseBlockTemplate('not-an-object')).toBeNull();
    expect(parseBlockTemplate(null)).toBeNull();
    expect(parseBlockTemplate(42)).toBeNull();
  });

  it('어휘 4종 밖 type이 섞이면 전체 null(AC1 — 부분 통과 없음)', () => {
    expect(parseBlockTemplate({ blocks: [{ type: 'header', text: 'x' }, { type: 'image', url: 'y' }] })).toBeNull();
  });

  it('header/text에 text 필드가 없으면 null', () => {
    expect(parseBlockTemplate({ blocks: [{ type: 'header' }] })).toBeNull();
  });

  it('fields의 각 entry에 label/value가 없으면 null', () => {
    expect(parseBlockTemplate({ blocks: [{ type: 'fields', fields: [{ label: 'x' }] }] })).toBeNull();
  });

  it('actions의 action이 "publish"가 아니면 null(v1 = 발행 버튼만)', () => {
    expect(parseBlockTemplate({
      blocks: [{ type: 'actions', actions: [{ label: 'x', action: 'webhook', definition_key: 'y' }] }],
    })).toBeNull();
  });

  it('actions.auth는 optional — 없어도 파싱된다', () => {
    const parsed = parseBlockTemplate({
      blocks: [{ type: 'actions', actions: [{ label: 'x', action: 'publish', definition_key: 'y' }] }],
    });
    expect(parsed).not.toBeNull();
    expect((parsed!.blocks[0] as { actions: unknown[] }).actions[0]).toEqual({ label: 'x', action: 'publish', definition_key: 'y' });
  });
});

describe('renderBlockTemplate — story #2637 AC0-b', () => {
  it('AC0-b 예시 전체를 실 payload로 렌더한다', () => {
    const template = parseBlockTemplate(AC0B_EXAMPLE)!;
    const payload = { work_item_type: 'story', from_status: 'in-progress', to_status: 'in-review', work_item_id: 'S-123' };
    const rendered = renderBlockTemplate(template, payload);

    expect(rendered[0]).toEqual({ type: 'header', text: '작업 상태 변경' });
    expect(rendered[1]).toEqual({ type: 'text', text: '**story** `in-progress` → `in-review`' });
    expect(rendered[2]).toEqual({
      type: 'fields',
      fields: [
        { label: '대상', value: 'S-123' },
        // note가 payload에 없음 — 명시 플레이스홀더로 남아야 한다.
        { label: '메모', value: '⟨missing: payload.note⟩' },
      ],
    });
    // actions는 정적 — 치환 없이 그대로.
    expect(rendered[3]).toEqual(template.blocks[3]);
  });

  it('알 수 없는 type이 섞인 원시 블록 배열이 renderBlockTemplate에 직접 들어오면 스킵한다(방어적)', () => {
    // parseBlockTemplate을 거치지 않은 손수 구성 — 타입 단언으로 방어 분기를 직접 검증.
    const template = { blocks: [{ type: 'header', text: 'ok' }, { type: 'unknown' }] } as unknown as Parameters<typeof renderBlockTemplate>[0];
    const rendered = renderBlockTemplate(template, {});
    expect(rendered).toEqual([{ type: 'header', text: 'ok' }]);
  });

  it('story #3332 — preset.gate.verdict 0301 마이그 실 예시: {{ref.work_item}}이 fields에서 클릭 토큰으로 치환된다', () => {
    const template = parseBlockTemplate({
      blocks: [
        { type: 'header', text: '게이트 판정' },
        { type: 'text', text: '**{{payload.gate_type}}** 게이트 — **{{payload.verdict}}**' },
        {
          type: 'fields',
          fields: [
            { label: '대상', value: '{{ref.work_item}}' },
            { label: '사유', value: '{{payload.resolution_note}}' },
          ],
        },
      ],
    })!;
    const payload = { gate_type: 'external_publish', verdict: 'rejected', resolution_note: '어투 정정' };
    const refs = { work_item: '[Threads 포스트 초안](entity:story:abc123)' };
    const rendered = renderBlockTemplate(template, payload, refs);

    expect(rendered[2]).toEqual({
      type: 'fields',
      fields: [
        { label: '대상', value: '[Threads 포스트 초안](entity:story:abc123)' },
        { label: '사유', value: '어투 정정' },
      ],
    });
  });

  it('refs 인자를 생략해도(구버전 호출부) payload 전용 템플릿은 그대로 회귀 0', () => {
    const template = parseBlockTemplate(AC0B_EXAMPLE)!;
    const payload = { work_item_type: 'story', from_status: 'in-progress', to_status: 'in-review', work_item_id: 'S-123' };
    expect(renderBlockTemplate(template, payload)).toEqual(renderBlockTemplate(template, payload, {}));
  });
});

describe('story #3884 — {{t.X}} 네임스페이스(4번째 mustache, payload와 무관한 고정 UI 카피)', () => {
  it('substituteMustache가 {{t.field}}를 translations 인자 값으로 치환한다', () => {
    const rendered = substituteMustache('{{t.targetLabel}}', {}, {}, {}, { targetLabel: '대상' });
    expect(rendered).toBe('대상');
  });

  it('translations에 없는 t 키는 명시 플레이스홀더로 드러난다(⟨missing: t.field⟩, 지어내지 않음)', () => {
    const rendered = substituteMustache('{{t.unknownKey}}', {}, {}, {}, {});
    expect(rendered).toBe('⟨missing: t.unknownKey⟩');
  });

  it('field.label도 이제 치환 대상이다(story #3884 이전엔 정적 텍스트였다)', () => {
    const template = parseBlockTemplate({
      blocks: [
        { type: 'fields', fields: [{ label: '{{t.targetLabel}}', value: '{{payload.id}}' }] },
      ],
    })!;
    const rendered = renderBlockTemplate(template, { id: 'S-1' }, {}, {}, { targetLabel: '대상' });
    expect(rendered[0]).toEqual({ type: 'fields', fields: [{ label: '대상', value: 'S-1' }] });
  });

  it('translations 인자를 생략해도(구버전 호출부) t 네임스페이스가 없는 템플릿은 그대로 회귀 0', () => {
    const template = parseBlockTemplate(AC0B_EXAMPLE)!;
    const payload = { work_item_type: 'story', from_status: 'in-progress', to_status: 'in-review', work_item_id: 'S-123' };
    expect(renderBlockTemplate(template, payload, {}, {})).toEqual(renderBlockTemplate(template, payload, {}, {}, {}));
  });
});

describe('story #3884 0376 마이그 실 예시 — 대상 참조 토큰화(label.work_item_target) + t 네임스페이스', () => {
  it('preset.work.status_changed — work_item_target이 찾음 토큰이면 대상 행에 클릭 참조가 뜬다', () => {
    // migration 0376_event_card_target_ref_and_ui_copy_t_namespace.py의 실물 그대로.
    const template = parseBlockTemplate({
      blocks: [
        { type: 'header', text: '{{t.statusChangedHeader}}' },
        { type: 'text', text: '**{{label.work_item_type}}** `{{label.from_status}}` → `{{label.to_status}}`' },
        {
          type: 'fields',
          fields: [
            { label: '{{t.targetLabel}}', value: '{{label.work_item_target}}', optional: true },
            { label: '{{t.noteLabel}}', value: '{{payload.note}}', optional: true },
          ],
        },
      ],
    })!;
    const payload = { work_item_type: 'story', from_status: 'ready-for-dev', to_status: 'in-progress', work_item_id: 'S-42' };
    const labels = {
      work_item_type: '스토리', from_status: '개발 대기', to_status: '진행 중',
      work_item_target: '[결제 흐름 재설계](entity:story:S-42)',
    };
    const translations = { statusChangedHeader: '작업 상태 변경', targetLabel: '대상', noteLabel: '메모' };
    const rendered = renderBlockTemplate(template, payload, {}, labels, translations);

    expect(rendered[0]).toEqual({ type: 'header', text: '작업 상태 변경' });
    expect(rendered[2]).toEqual({
      type: 'fields',
      fields: [{ label: '대상', value: '[결제 흐름 재설계](entity:story:S-42)' }],
    }); // 「메모」는 payload에 note가 없어 줄 생략(AC3 elision).
  });

  it('AC1(d) — 리졸버가 있는데 못 찾음(삭제)이면 대상 행이 elide되지 않고 은은한 targetMissing 문구가 뜬다', () => {
    const template = parseBlockTemplate({
      blocks: [
        { type: 'fields', fields: [{ label: '{{t.targetLabel}}', value: '{{label.work_item_target}}', optional: true }] },
      ],
    })!;
    // EventBlockCard가 refs.work_item={found:false,type:'story'}일 때 이렇게 채운다
    // (targetMissing은 event-block-card.tsx가 t()로 미리 조립 — 여기선 그 결과 문자열만).
    const labels = { work_item_target: '(삭제된 스토리)' };
    const translations = { targetLabel: '대상' };
    const rendered = renderBlockTemplate(template, {}, {}, labels, translations);

    expect(rendered[0]).toEqual({ type: 'fields', fields: [{ label: '대상', value: '(삭제된 스토리)' }] });
  });

  it('AC1(d) — 리졸버 자체가 없는 타입(agent_decision 등)이면 labels.work_item_target을 아예 안 채워 대상 행이 줄 생략된다', () => {
    const template = parseBlockTemplate({
      blocks: [
        { type: 'fields', fields: [
          { label: '{{t.targetLabel}}', value: '{{label.work_item_target}}', optional: true },
          { label: '고정 행', value: '항상 보임' },
        ] },
      ],
    })!;
    // EventBlockCard가 refs.work_item 키 자체가 없을 때(리졸버 없음) labels에도 안 채운다.
    const labels: Record<string, string> = {};
    const translations = { targetLabel: '대상' };
    const rendered = renderBlockTemplate(template, {}, {}, labels, translations);

    expect(rendered[0]).toEqual({ type: 'fields', fields: [{ label: '고정 행', value: '항상 보임' }] });
  });

  it('뮤테이션 셀프체크 — optional 필드를 항상 fail-loud로 되돌리면 위 elision 테스트들이 RED로 돌아간다', () => {
    // renderBlockTemplate의 elision 필터를 우회(원본 block.fields를 그대로 씀)한 경우와
    // 비교 — optional:true인데 걸러지지 않으면 ⟨missing: label.work_item_target⟩이
    // 그대로 남는다는 걸 직접 확認(회귀 조건 실측, 프로덕션 코드는 건드리지 않는다).
    const template = parseBlockTemplate({
      blocks: [
        { type: 'fields', fields: [{ label: '대상', value: '{{label.work_item_target}}', optional: true }] },
      ],
    })!;
    const labels: Record<string, string> = {};
    const rendered = renderBlockTemplate(template, {}, {}, labels, {});
    // 정상 경로(elision 작동) — 필드 자체가 사라진다.
    expect(rendered[0]).toEqual({ type: 'fields', fields: [] });
    // elision이 없었다면 이 값이 나왔을 것(대조군 — 실제로 그 모양임을 직접 확認).
    const withoutElision = substituteMustache('{{label.work_item_target}}', {}, {}, labels, {});
    expect(withoutElision).toBe('⟨missing: label.work_item_target⟩');
  });

  it('preset.gate.verdict — gate_connective_line이 리터럴 「게이트」 없이 gateType/verdict 두 라벨만 담는다', () => {
    // 0376의 구조 정정(PO) — 미등재 gate_type이 ccGateGeneric 「게이트」 폴백일 때
    // "게이트 게이트 — …" 이중 인쇄를 막는다(gateVerdictHeader가 맥락을 이미 운반).
    const template = parseBlockTemplate({
      blocks: [
        { type: 'header', text: '{{t.gateVerdictHeader}}' },
        { type: 'text', text: '{{label.gate_connective_line}}' },
      ],
    })!;
    const labels = { gate_connective_line: '**외부 발행** — **승인됨**' };
    const translations = { gateVerdictHeader: '게이트 판정' };
    const rendered = renderBlockTemplate(template, {}, {}, labels, translations);

    expect(rendered[1]).toEqual({ type: 'text', text: '**외부 발행** — **승인됨**' });
    expect((rendered[1] as { text: string }).text).not.toContain('게이트 —');
  });
});
