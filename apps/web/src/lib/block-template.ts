// story #2637 AC0-b — event_definitions.block_template v1 순수 파서/타입. SSOT는 스토리 AC0-b의
// 실물 JSON(SID:2637, PO 확定) — 어휘 4종(header/text/fields/actions)·payload 머스태시
// (`{{payload.field}}`)·치환 실패는 조용한 공백이 아니라 명시 플레이스홀더(`⟨missing: payload.x⟩`).
//
// 이 파일은 msg_metadata 배선(BE #2637 AC0-a, 착수 대기)·실제 렌더 컴포넌트(React) 둘 다에
// 의존하지 않는 순수 데이터 변환만 담는다 — BE 착지 전에 안전하게 미리 짜둘 수 있는 부분(PO
// 08-14 지시).

export interface BlockTemplateHeader {
  type: 'header';
  text: string;
}

export interface BlockTemplateText {
  type: 'text';
  text: string;
}

export interface BlockTemplateFieldEntry {
  label: string;
  value: string;
}

export interface BlockTemplateFields {
  type: 'fields';
  fields: BlockTemplateFieldEntry[];
}

export interface BlockTemplateActionAuth {
  human_only?: boolean;
  role?: string[];
}

export interface BlockTemplateActionEntry {
  label: string;
  action: 'publish';
  definition_key: string;
  auth?: BlockTemplateActionAuth;
}

export interface BlockTemplateActions {
  type: 'actions';
  actions: BlockTemplateActionEntry[];
}

export type BlockTemplateBlock = BlockTemplateHeader | BlockTemplateText | BlockTemplateFields | BlockTemplateActions;

export interface BlockTemplate {
  blocks: BlockTemplateBlock[];
}

/** story #2637 — GET /api/v2/events/definitions(BE #2634/#3036) 응답 1건 미러. `block_template`은
 * BE가 raw JSONB 그대로 주므로 여기선 unknown — 소비부가 parseBlockTemplate()을 거친다. */
export interface EventDefinitionSummary {
  key: string;
  org_id: string | null;
  payload_schema: Record<string, unknown>;
  routing: Record<string, unknown>;
  block_template: unknown;
  enabled: boolean;
  version: number;
}

// AC1 "어휘 4종 밖 type 거부" — 등록 게이트(BE)의 몫이지만, FE 렌더러도 같은 닫힌 어휘로
// 판별해야 미지 타입을 조용히 지어내 그리지 않는다(no-fiction) — 단일 SSOT로 둔다.
export const BLOCK_TEMPLATE_TYPES = ['header', 'text', 'fields', 'actions'] as const;

export function isKnownBlockType(type: string): type is BlockTemplateBlock['type'] {
  return (BLOCK_TEMPLATE_TYPES as readonly string[]).includes(type);
}

// story #3332 — `{{ref.X}}`(2번째 머스태시 네임스페이스, `{{payload.X}}`와 병렬) 신설. payload는
// 발행자가 직접 준 값이지만, ref는 **서버가 발행 시점에 계산한 참조 토큰**(클릭 가능한
// `[제목](entity:type:id)`, events.py::_publish_registry_event_core의 `refs` — BE
// event_definition_registry.py::BLOCK_TEMPLATE_REF_VOCAB과 짝인 어휘, 지금은 work_item 1종).
const MUSTACHE_RE = /\{\{(payload|ref)\.([a-zA-Z0-9_]+)\}\}/g;

/**
 * `{{payload.field}}`/`{{ref.field}}` 머스태시를 치환한다. `payload`는 payload 값(없거나
 * null/undefined면 `⟨missing: payload.field⟩`), `ref`는 `refs` 인자의 값(없거나 null이면
 * `⟨missing: ref.field⟩`) — 둘 다 조용히 공백으로 지우지 않고 실패를 명시한다(AC0-b 원칙의
 * ref 네임스페이스 확장). 값이 문자열이 아니면(숫자·불리언 등) String()으로 직렬화한다 —
 * payload는 JSON이라 임의 타입이 올 수 있다(refs는 항상 string | null이라 해당 없음).
 */
export function substituteMustache(
  template: string,
  payload: Record<string, unknown>,
  refs: Record<string, string | null> = {},
): string {
  return template.replace(MUSTACHE_RE, (_match, namespace: string, field: string) => {
    if (namespace === 'ref') {
      const value = refs[field];
      if (value === undefined || value === null) return `⟨missing: ref.${field}⟩`;
      return value;
    }
    if (!(field in payload) || payload[field] === null || payload[field] === undefined) {
      return `⟨missing: payload.${field}⟩`;
    }
    return String(payload[field]);
  });
}

/** BlockTemplateFields 하나의 각 field.value에 머스태시 치환을 적용한 새 배열을 만든다. */
function substituteFieldEntries(
  fields: BlockTemplateFieldEntry[],
  payload: Record<string, unknown>,
  refs: Record<string, string | null>,
): BlockTemplateFieldEntry[] {
  return fields.map((f) => ({ label: f.label, value: substituteMustache(f.value, payload, refs) }));
}

/**
 * 블록 배열 전체에 payload/refs를 치환해 "렌더 준비된" 블록 배열을 만든다(아직 JSX 아님 —
 * 순수 데이터 변환). header/text의 `text`, fields의 각 `value`가 치환 대상이다. actions는
 * 라벨/definition_key가 정적 텍스트라 치환 대상이 아니다(AC0-b 예시에 머스태시가 없음).
 * 알 수 없는 type은 스킵한다(등록 게이트를 통과한 template이라면 원래 없어야 하지만, 방어적
 * — 조용히 죽지 않고 렌더 결과에서 빠지는 것으로 정직하게 처리). `refs` 생략(기존 호출부)은
 * 완전 additive — `{{ref.X}}`가 없는 템플릿은 그대로, 있는데 refs를 안 주면 명시 플레이스홀더로
 * 정직하게 드러난다(지어내지 않음).
 */
export function renderBlockTemplate(
  template: BlockTemplate,
  payload: Record<string, unknown>,
  refs: Record<string, string | null> = {},
): BlockTemplateBlock[] {
  const out: BlockTemplateBlock[] = [];
  for (const block of template.blocks) {
    if (block.type === 'header' || block.type === 'text') {
      out.push({ type: block.type, text: substituteMustache(block.text, payload, refs) });
    } else if (block.type === 'fields') {
      out.push({ type: 'fields', fields: substituteFieldEntries(block.fields, payload, refs) });
    } else if (block.type === 'actions') {
      out.push(block);
    }
  }
  return out;
}

/**
 * BE가 준 raw JSON(event_definitions.block_template 칸)이 이 v1 계약을 만족하는지 최소
 * 검증한다 — `blocks` 배열 존재 + 각 원소가 알려진 4종 중 하나 + 그 타입에 필요한 필드가
 * 있는지. 실패하면 null(호출부가 제네릭 폴백으로 내려간다 — AC2 비회귀 축과 동형 원칙:
 * "형태가 이상하면 조용히 지어내지 않고 폴백"). BE 등록 게이트가 이미 걸러도, FE는 구버전
 * 캐시·BE-FE 배포 시차를 신뢰하지 않는다(옛 서버 폴백류와 같은 방어).
 */
export function parseBlockTemplate(raw: unknown): BlockTemplate | null {
  if (typeof raw !== 'object' || raw === null || !('blocks' in raw)) return null;
  const blocks = (raw as { blocks: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;

  const parsed: BlockTemplateBlock[] = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null || typeof (b as { type?: unknown }).type !== 'string') return null;
    const type = (b as { type: string }).type;
    if (!isKnownBlockType(type)) return null;

    if (type === 'header' || type === 'text') {
      const text = (b as { text?: unknown }).text;
      if (typeof text !== 'string') return null;
      parsed.push({ type, text });
    } else if (type === 'fields') {
      const fields = (b as { fields?: unknown }).fields;
      if (!Array.isArray(fields)) return null;
      const parsedFields: BlockTemplateFieldEntry[] = [];
      for (const f of fields) {
        if (typeof f !== 'object' || f === null) return null;
        const label = (f as { label?: unknown }).label;
        const value = (f as { value?: unknown }).value;
        if (typeof label !== 'string' || typeof value !== 'string') return null;
        parsedFields.push({ label, value });
      }
      parsed.push({ type: 'fields', fields: parsedFields });
    } else if (type === 'actions') {
      const actions = (b as { actions?: unknown }).actions;
      if (!Array.isArray(actions)) return null;
      const parsedActions: BlockTemplateActionEntry[] = [];
      for (const a of actions) {
        if (typeof a !== 'object' || a === null) return null;
        const label = (a as { label?: unknown }).label;
        const action = (a as { action?: unknown }).action;
        const definitionKey = (a as { definition_key?: unknown }).definition_key;
        if (typeof label !== 'string' || action !== 'publish' || typeof definitionKey !== 'string') return null;
        const rawAuth = (a as { auth?: unknown }).auth;
        let auth: BlockTemplateActionAuth | undefined;
        if (rawAuth !== undefined) {
          if (typeof rawAuth !== 'object' || rawAuth === null) return null;
          const humanOnly = (rawAuth as { human_only?: unknown }).human_only;
          const role = (rawAuth as { role?: unknown }).role;
          if (humanOnly !== undefined && typeof humanOnly !== 'boolean') return null;
          if (role !== undefined && (!Array.isArray(role) || role.some((r) => typeof r !== 'string'))) return null;
          auth = { ...(humanOnly !== undefined ? { human_only: humanOnly } : {}), ...(role !== undefined ? { role: role as string[] } : {}) };
        }
        parsedActions.push({ label, action: 'publish', definition_key: definitionKey, ...(auth ? { auth } : {}) });
      }
      parsed.push({ type: 'actions', actions: parsedActions });
    }
  }
  return { blocks: parsed };
}
