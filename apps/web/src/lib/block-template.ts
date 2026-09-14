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
  /** story #3881 — true면 `value`가 단일 `{{payload.X}}`/`{{label.X}}`/`{{ref.X}}` 토큰
   * 하나뿐이고 그 변수가 없을 때, ⟨missing: …⟩ 플레이스홀더를 그리는 대신 이 field entry
   * 자체를 출력 배열에서 제외한다(줄 생략). 미지정(기본, undefined)은 기존 fail-loud
   * 그대로(하위호환 — 값이 정적 텍스트와 섞여 있거나 여러 토큰이면 이 플래그가 있어도
   * 판정 대상이 아니다, 아래 isSoleMissingVariable 참고). */
  optional?: boolean;
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
//
// story #3881 — `{{label.X}}`(3번째 네임스페이스) 신설. payload가 원시 slug/enum(예: story
// status "ready-for-dev", gate verdict "approved")을 실어 보내면 그 값을 **발행 시점에**
// 문자열로 굳혀 저장할 수 없다 — 읽는 사람의 로케일(en 사용자)·org 커스텀 라벨(도메인
// 탈고정, #3287)에 따라 같은 slug도 다른 문구여야 하기 때문이다(PO 확定 2026-09-14). 그래서
// «렌더 시점»(FE)에 해석해야 하고, block-template.ts는 순수 함수로 남아야 하므로(t()/React
// context 의존 금지, 파일 상단 원칙) `ref`와 동형으로 **호출부가 미리 계산해 넘기는**
// `labels: Record<string, string>` 인자를 받는다 — 새 기전 발명이 아니라 ref 패턴 재사용.
//
// story #3884 — `{{t.X}}`(4번째 네임스페이스) 신설. preset 템플릿의 헤더·필드 라벨·접속어
// (예: 「작업 상태 변경」·「대상」)가 BE 마이그(0249)에 한국어로 baked돼 en 로케일 사용자도
// 고정 문구가 한글이었다(원시 slug와 같은 "발행 시점 고정" 결함 클래스). `label`과 구분하는
// 이유: `label`은 **payload에서 파생**된 값(이벤트마다 달라짐)인 반면 `t`는 **payload와
// 무관한 고정 UI 문구**(정적 어휘, `useTranslations('eventCard')` 낱말 표 그대로) — 이
// 구분을 네임스페이스로 남겨야 마이그를 읽는 사람이 "이 자리가 데이터냐 UI 카피냐"를 한눈에
// 안다(PO 확定 2026-09-14, label 패턴의 확장·새 기전 아님).
const MUSTACHE_RE = /\{\{(payload|ref|label|t)\.([a-zA-Z0-9_]+)\}\}/g;

/**
 * `{{payload.field}}`/`{{ref.field}}`/`{{label.field}}`/`{{t.field}}` 머스태시를 치환한다.
 * `payload`는 payload 값(없거나 null/undefined면 `⟨missing: payload.field⟩`), `ref`는
 * `refs` 인자의 값(없거나 null이면 `⟨missing: ref.field⟩`), `label`은 `labels` 인자의 값
 * (없으면 `⟨missing: label.field⟩`), `t`는 `translations` 인자의 값(없으면
 * `⟨missing: t.field⟩`) — 넷 다 조용히 공백으로 지우지 않고 실패를 명시한다(AC0-b 원칙의
 * label/t 네임스페이스 확장, story #3881/#3884). 값이 문자열이 아니면(숫자·불리언 등)
 * String()으로 직렬화한다 — payload는 JSON이라 임의 타입이 올 수 있다(refs/labels/
 * translations는 항상 string이라 해당 없음).
 */
export function substituteMustache(
  template: string,
  payload: Record<string, unknown>,
  refs: Record<string, string | null> = {},
  labels: Record<string, string> = {},
  translations: Record<string, string> = {},
): string {
  return template.replace(MUSTACHE_RE, (_match, namespace: string, field: string) => {
    if (namespace === 'ref') {
      const value = refs[field];
      if (value === undefined || value === null) return `⟨missing: ref.${field}⟩`;
      return value;
    }
    if (namespace === 'label') {
      const value = labels[field];
      if (value === undefined) return `⟨missing: label.${field}⟩`;
      return value;
    }
    if (namespace === 't') {
      const value = translations[field];
      if (value === undefined) return `⟨missing: t.${field}⟩`;
      return value;
    }
    if (!(field in payload) || payload[field] === null || payload[field] === undefined) {
      return `⟨missing: payload.${field}⟩`;
    }
    return String(payload[field]);
  });
}

/** BlockTemplateFields 하나의 각 field.label·field.value에 머스태시 치환을 적용한 새 배열을
 * 만든다. story #3884부터 label도 치환 대상이다(`{{t.targetLabel}}` 등 — 이전엔 label이
 * 정적 텍스트 그대로였다). */
function substituteFieldEntries(
  fields: BlockTemplateFieldEntry[],
  payload: Record<string, unknown>,
  refs: Record<string, string | null>,
  labels: Record<string, string>,
  translations: Record<string, string>,
): BlockTemplateFieldEntry[] {
  return fields.map((f) => ({
    label: substituteMustache(f.label, payload, refs, labels, translations),
    value: substituteMustache(f.value, payload, refs, labels, translations),
  }));
}

// story #3881 AC3 — field.value가 «단일 토큰 하나뿐」(정적 텍스트 섞임 0)인지 판별한다.
// optional 판정은 이 모양일 때만 적용한다 — 정적 텍스트와 섞인 값("메모: {{payload.note}}")
// 까지 통째로 줄 생략하면 그 정적 텍스트("메모:")까지 조용히 사라져 저자 의도를 지어내게
// 된다(이 스토리의 실 프리셋 3곳은 전부 단일 토큰 형태라 이 제약이 실사용을 막지 않는다).
const SOLE_MUSTACHE_RE = /^\{\{(payload|ref|label|t)\.([a-zA-Z0-9_]+)\}\}$/;

function isSoleMissingVariable(
  value: string,
  payload: Record<string, unknown>,
  refs: Record<string, string | null>,
  labels: Record<string, string>,
  translations: Record<string, string>,
): boolean {
  const m = value.trim().match(SOLE_MUSTACHE_RE);
  if (!m) return false;
  const [, namespace, field] = m;
  if (namespace === 'payload') return !(field in payload) || payload[field] === null || payload[field] === undefined;
  if (namespace === 'ref') return !(field in refs) || refs[field] === null || refs[field] === undefined;
  if (namespace === 't') return !(field in translations) || translations[field] === undefined;
  return !(field in labels) || labels[field] === undefined;
}

/**
 * 블록 배열 전체에 payload/refs/labels/translations를 치환해 "렌더 준비된" 블록 배열을
 * 만든다(아직 JSX 아님 — 순수 데이터 변환). header/text의 `text`, fields의 각 `label`·
 * `value`가 치환 대상이다(story #3884부터 field.label도 포함 — 이전엔 정적 텍스트였다).
 * actions는 라벨/definition_key가 정적 텍스트라 치환 대상이 아니다(AC0-b 예시에 머스태시가
 * 없음). 알 수 없는 type은 스킵한다(등록 게이트를 통과한 template이라면 원래 없어야 하지만,
 * 방어적 — 조용히 죽지 않고 렌더 결과에서 빠지는 것으로 정직하게 처리). `refs`/`labels`/
 * `translations` 생략(기존 호출부)은 완전 additive — 해당 네임스페이스 토큰이 없는
 * 템플릿은 그대로, 있는데 인자를 안 주면 명시 플레이스홀더로 정직하게 드러난다(지어내지
 * 않음).
 *
 * story #3881 AC3 — fields 블록은 `optional: true`인 entry 中 값이 단일 미해소 변수뿐인
 * 것을 치환 *前*에 걸러낸다(⟨missing:…⟩ 플레이스홀더가 아예 안 뜬다 — "줄 생략"). 판정은
 * payload/refs/labels 원본 데이터로 하고(치환된 문자열을 역파싱하지 않는다 — 사용자 콘텐츠가
 * 우연히 마커 문자열과 같아지는 오탐 0), optional 미지정 필드는 기존 fail-loud 그대로
 * (하위호환·회귀 0).
 */
export function renderBlockTemplate(
  template: BlockTemplate,
  payload: Record<string, unknown>,
  refs: Record<string, string | null> = {},
  labels: Record<string, string> = {},
  translations: Record<string, string> = {},
): BlockTemplateBlock[] {
  const out: BlockTemplateBlock[] = [];
  for (const block of template.blocks) {
    if (block.type === 'header' || block.type === 'text') {
      out.push({ type: block.type, text: substituteMustache(block.text, payload, refs, labels, translations) });
    } else if (block.type === 'fields') {
      const visibleFields = block.fields.filter(
        (f) => !(f.optional && isSoleMissingVariable(f.value, payload, refs, labels, translations)),
      );
      out.push({ type: 'fields', fields: substituteFieldEntries(visibleFields, payload, refs, labels, translations) });
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
        // story #3881 — optional은 정말 옵셔널(생략 시 undefined, 기존 fail-loud 그대로).
        // 지정될 땐 boolean이어야 한다(느슨한 truthy 허용 0 — 어휘 검증 규율 그대로).
        const optionalRaw = (f as { optional?: unknown }).optional;
        if (optionalRaw !== undefined && typeof optionalRaw !== 'boolean') return null;
        parsedFields.push({ label, value, ...(optionalRaw !== undefined ? { optional: optionalRaw } : {}) });
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
