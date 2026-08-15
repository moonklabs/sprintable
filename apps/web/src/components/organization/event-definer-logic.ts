// story #2670(A층) — 휴먼용 이벤트 정의기 폼 상태 ↔ 서버 JSON(payload_schema/routing/
// action_auth/block_template) 순수 변환. 핸드오프 스펙(doc `human-event-definer-handoff-v1`
// v1.1, §2-3, R1~R4)의 실측 규격 그대로 — 서버 검증(backend/app/services/
// event_definition_registry.py)과 반드시 일치해야 게이트를 통과한다(그라운딩: 두 정규식·
// routing 2택·action_auth 화이트리스트 전부 그 파일 직접 대조).
import type { BlockTemplate, BlockTemplateBlock } from '@/lib/block-template';

export type DefinerFormat = 'cycle' | 'signal' | 'measure';

export interface DefinerStage {
  id: string;
  name: string;
  slug: string;
}

export interface DefinerField {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  required: boolean;
}

// R4 — 커스텀 등록 게이트가 server_derived(target≠none)를 금지(프리셋 전용 의미론)라 v1은
// 2택. "관계자에게"(work_item_stakeholders)는 후속(서버 의미론 확장 필요).
export type DefinerRouting = 'assign_on_publish' | 'record_only';

export interface DefinerFormState {
  format: DefinerFormat;
  name: string;
  keySuffix: string;
  // 사이클형
  stages: DefinerStage[];
  // 신호형
  signalKinds: string[];
  includeSummary: boolean;
  // 측정형
  includeMetricUnit: boolean;
  includeSource: boolean;
  // 공통
  routing: DefinerRouting;
  humanOnly: boolean;
  rolesCsv: string;
  fields: DefinerField[];
}

export function makeId(): string {
  // crypto.randomUUID는 이 런타임(브라우저)에서 항상 있다 — Math.random 폴백 불필요.
  return crypto.randomUUID();
}

export function emptyFormState(format: DefinerFormat = 'cycle'): DefinerFormState {
  return {
    format,
    name: '',
    keySuffix: '',
    stages: [],
    signalKinds: [],
    includeSummary: true,
    includeMetricUnit: true,
    includeSource: true,
    routing: 'assign_on_publish',
    humanOnly: false,
    rolesCsv: '',
    fields: [],
  };
}

// R1 — 서버 정규식(_ORG_KEY_RE)의 접미 세그먼트는 `[a-z0-9_]+`뿐, 하이픈 불허(org slug
// 자체의 `[a-z0-9-]+`와 다른 축 — 그건 고정 접두라 사용자가 못 침). 한글 등 비ASCII 이름을
// 기계적으로 의미 번역할 수 없어(예: "초안 작성"→"draft"는 사람이 지은 것) 자동파생은
// "합리적 근사"만 시도하고, 결과가 비면(전부 비ASCII 등) stage_N 자리표시자로 폴백 — 사용자가
// 항상 수정 가능하다는 전제(스펙 §2 "자동 파생 실패해도 편집 가능").
export function slugify(name: string, fallbackIndex: number): string {
  const ascii = name
    .trim()
    .toLowerCase()
    // 공백·하이픈을 먼저 언더스코어로 바꿔 단어 경계를 보존한다 — 순서를 바꿔 하이픈을
    // "허용 밖 문자"로 먼저 제거해버리면 "pre-flight"가 "preflight"로 뭉개진다(회귀가드
    // 테스트로 고정된 실버그).
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return ascii || `stage_${fallbackIndex + 1}`;
}

// #2666 클라 선검증 — 서버 정규식과 동일 문자셋. 접두 불일치와 문자셋 위반을 각각 다른
// 메시지로 가른다(핸드오프 스펙 §2 "#43201862 오진 함정" — 하나로 뭉치면 사용자가 원인을
// 못 짚는다).
export function validateKeySuffix(suffix: string): string | null {
  if (!suffix.trim()) return 'empty';
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(suffix)) return 'charset';
  return null;
}

export function validateFieldName(name: string): boolean {
  return /^[a-z0-9_]+$/.test(name);
}

const JSON_SCHEMA_TYPE: Record<DefinerField['type'], { type: string; format?: string }> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
};

function fieldsToProperties(fields: DefinerField[]): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    if (!f.name.trim() || !validateFieldName(f.name)) continue;
    properties[f.name] = JSON_SCHEMA_TYPE[f.type];
    if (f.required) required.push(f.name);
  }
  return { properties, required };
}

// R4 — routing 2택 파생. escalation leg는 R3 정정대로 항상 명시(server_derived·target=none,
// 누락 금지 — 서버가 두 leg 모두 object를 요구).
function deriveRouting(routing: DefinerRouting): Record<string, unknown> {
  const broadcast = routing === 'assign_on_publish'
    ? { kind: 'payload_field', member_id_field: 'assignee_member_id' }
    : { kind: 'server_derived', target: 'none' };
  return {
    escalation: { kind: 'server_derived', target: 'none' },
    broadcast,
  };
}

function deriveActionAuth(humanOnly: boolean, rolesCsv: string): Record<string, unknown> | null {
  const role = rolesCsv.split(',').map((r) => r.trim()).filter(Boolean);
  if (!humanOnly && role.length === 0) return null;
  const auth: Record<string, unknown> = {};
  if (humanOnly) auth.human_only = true;
  if (role.length > 0) auth.role = role;
  return auth;
}

export interface DerivedDefinition {
  key: string;
  payload_schema: Record<string, unknown>;
  routing: Record<string, unknown>;
  action_auth: Record<string, unknown> | null;
  block_template: BlockTemplate;
  samplePayload: Record<string, unknown>;
}

function buildFieldsBlock(fields: DefinerField[]): BlockTemplateBlock | null {
  const valid = fields.filter((f) => f.name.trim() && validateFieldName(f.name));
  if (valid.length === 0) return null;
  return { type: 'fields', fields: valid.map((f) => ({ label: f.name, value: `{{payload.${f.name}}}` })) };
}

function extraFieldsSample(fields: DefinerField[]): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.name.trim() || !validateFieldName(f.name)) continue;
    sample[f.name] = f.type === 'number' ? 0 : f.type === 'boolean' ? true : f.type === 'date' ? new Date(0).toISOString() : `예시 ${f.name}`;
  }
  return sample;
}

/** 사이클형 — §2 서식① 그대로: stage enum + 추가 필드 → payload_schema, header+text("**{현재
 * stage}**로 넘어갔습니다")+fields → block_template. */
export function deriveCycle(state: DefinerFormState, orgSlug: string): DerivedDefinition {
  const validStages = state.stages.filter((s) => s.name.trim() && s.slug.trim());
  const stageSlugs = validStages.map((s) => s.slug);
  const { properties: fieldProps, required: fieldRequired } = fieldsToProperties(state.fields);
  const payload_schema = {
    type: 'object',
    properties: { stage: { type: 'string', enum: stageSlugs }, ...fieldProps },
    required: ['stage', ...fieldRequired],
    additionalProperties: false,
  };
  const sampleStage = stageSlugs[stageSlugs.length - 1] ?? 'stage_1';
  const samplePayload = { stage: sampleStage, ...extraFieldsSample(state.fields) };
  const fieldsBlock = buildFieldsBlock(state.fields);
  const block_template: BlockTemplate = {
    blocks: [
      { type: 'header', text: state.name || '(이름 없음)' },
      { type: 'text', text: '단계 **{{payload.stage}}** 로 넘어갔습니다.' },
      ...(fieldsBlock ? [fieldsBlock] : []),
    ],
  };
  return {
    key: `org.${orgSlug}.${state.keySuffix}`,
    payload_schema,
    routing: deriveRouting(state.routing),
    action_auth: deriveActionAuth(state.humanOnly, state.rolesCsv),
    block_template,
    samplePayload,
  };
}

/** 신호형 — §2 서식②: kind + (선택)summary → payload_schema, header+text. */
export function deriveSignal(state: DefinerFormState, orgSlug: string): DerivedDefinition {
  const kinds = state.signalKinds.map((k) => k.trim()).filter(Boolean);
  const { properties: fieldProps, required: fieldRequired } = fieldsToProperties(state.fields);
  const properties: Record<string, unknown> = { kind: { type: 'string', enum: kinds.length > 0 ? kinds : ['default'] }, ...fieldProps };
  const required = ['kind', ...fieldRequired];
  if (state.includeSummary) { properties.summary = { type: 'string' }; }
  const payload_schema = { type: 'object', properties, required, additionalProperties: false };
  const samplePayload: Record<string, unknown> = { kind: kinds[0] ?? 'default', ...extraFieldsSample(state.fields) };
  if (state.includeSummary) samplePayload.summary = '예시 요약';
  const signalFieldsBlock = buildFieldsBlock(state.fields);
  const block_template: BlockTemplate = {
    blocks: [
      { type: 'header', text: state.name || '(이름 없음)' },
      { type: 'text', text: state.includeSummary ? '{{payload.summary}}' : '**{{payload.kind}}**' },
      ...(signalFieldsBlock ? [signalFieldsBlock] : []),
    ],
  };
  return {
    key: `org.${orgSlug}.${state.keySuffix}`,
    payload_schema,
    routing: deriveRouting(state.routing),
    action_auth: deriveActionAuth(state.humanOnly, state.rolesCsv),
    block_template,
    samplePayload,
  };
}

/** 측정형 — §2 서식③: metric_value(필수) + metric_unit?/source? → payload_schema. */
export function deriveMeasure(state: DefinerFormState, orgSlug: string): DerivedDefinition {
  const { properties: fieldProps, required: fieldRequired } = fieldsToProperties(state.fields);
  const properties: Record<string, unknown> = { metric_value: { type: 'number' }, ...fieldProps };
  const required = ['metric_value', ...fieldRequired];
  if (state.includeMetricUnit) properties.metric_unit = { type: 'string' };
  if (state.includeSource) properties.source = { type: 'string' };
  const payload_schema = { type: 'object', properties, required, additionalProperties: false };
  const samplePayload: Record<string, unknown> = { metric_value: 42, ...extraFieldsSample(state.fields) };
  if (state.includeMetricUnit) samplePayload.metric_unit = '%';
  if (state.includeSource) samplePayload.source = '예시 출처';
  const fieldsBlock: { label: string; value: string }[] = [{ label: '측정치', value: state.includeMetricUnit ? '{{payload.metric_value}} {{payload.metric_unit}}' : '{{payload.metric_value}}' }];
  if (state.includeSource) fieldsBlock.push({ label: '출처', value: '{{payload.source}}' });
  for (const f of state.fields) { if (f.name.trim() && validateFieldName(f.name)) fieldsBlock.push({ label: f.name, value: `{{payload.${f.name}}}` }); }
  const block_template: BlockTemplate = {
    blocks: [
      { type: 'header', text: state.name || '(이름 없음)' },
      { type: 'fields', fields: fieldsBlock },
    ],
  };
  return {
    key: `org.${orgSlug}.${state.keySuffix}`,
    payload_schema,
    routing: deriveRouting(state.routing),
    action_auth: deriveActionAuth(state.humanOnly, state.rolesCsv),
    block_template,
    samplePayload,
  };
}

export function deriveDefinition(state: DefinerFormState, orgSlug: string): DerivedDefinition {
  if (state.format === 'cycle') return deriveCycle(state, orgSlug);
  if (state.format === 'signal') return deriveSignal(state, orgSlug);
  return deriveMeasure(state, orgSlug);
}

// AC3 — JSON→폼 왕복. 폼이 표현할 수 있는 정확한 모양(이 파일의 derive* 함수들이 만드는 것과
// 구조적으로 동형)일 때만 성공한다 — 조금이라도 벗어나면(사람이 고급 탭에서 직접 편집했거나,
// 이 기능 이전에 만들어진 정의 등) null을 반환해 호출부가 "고급 전용" 배지로 정직하게
// 떨어뜨린다(표현 못 하는 걸 억지로 욱여넣어 데이터를 잃는 것보다 안전).
export function tryReverseParse(
  key: string,
  payload_schema: Record<string, unknown>,
  routing: Record<string, unknown>,
  action_auth: Record<string, unknown> | null,
  orgSlug: string,
): DefinerFormState | null {
  try {
    const prefix = `org.${orgSlug}.`;
    if (!key.startsWith(prefix)) return null;
    const keySuffix = key.slice(prefix.length);

    const properties = payload_schema.properties as Record<string, { type?: string; format?: string; enum?: string[] }> | undefined;
    if (!properties || typeof properties !== 'object') return null;
    const required = new Set((payload_schema.required as string[] | undefined) ?? []);

    // routing 2택 역해석(R4) — 이 두 모양 밖이면 표현 불가.
    const esc = routing.escalation as { kind?: string; target?: string } | undefined;
    const bc = routing.broadcast as { kind?: string; target?: string; member_id_field?: string } | undefined;
    if (esc?.kind !== 'server_derived' || esc.target !== 'none') return null;
    let derivedRouting: DefinerRouting;
    if (bc?.kind === 'payload_field') derivedRouting = 'assign_on_publish';
    else if (bc?.kind === 'server_derived' && bc.target === 'none') derivedRouting = 'record_only';
    else return null;

    const humanOnly = action_auth?.human_only === true;
    const roleList = Array.isArray(action_auth?.role) ? (action_auth!.role as string[]) : [];
    const rolesCsv = roleList.join(', ');
    // action_auth v1 화이트리스트 밖 키가 있으면(폼이 만들 수 없는 모양) 고급 전용.
    if (action_auth && !Object.keys(action_auth).every((k) => k === 'human_only' || k === 'role')) return null;

    const base = emptyFormState();
    base.keySuffix = keySuffix;
    base.routing = derivedRouting;
    base.humanOnly = humanOnly;
    base.rolesCsv = rolesCsv;

    if ('stage' in properties && properties.stage?.enum) {
      const { stage, ...rest } = properties;
      void stage;
      base.format = 'cycle';
      base.stages = (properties.stage!.enum ?? []).map((slug) => ({ id: makeId(), name: slug, slug }));
      base.fields = objectToFields(rest, required, new Set(['stage']));
      return base;
    }
    if ('kind' in properties) {
      const { kind, summary, ...rest } = properties;
      base.format = 'signal';
      base.signalKinds = kind?.enum ?? [];
      base.includeSummary = 'summary' in properties;
      void summary;
      base.fields = objectToFields(rest, required, new Set(['kind', 'summary']));
      return base;
    }
    if ('metric_value' in properties) {
      const { metric_value, metric_unit, source, ...rest } = properties;
      void metric_value;
      base.format = 'measure';
      base.includeMetricUnit = 'metric_unit' in properties;
      base.includeSource = 'source' in properties;
      void metric_unit; void source;
      base.fields = objectToFields(rest, required, new Set(['metric_value', 'metric_unit', 'source']));
      return base;
    }
    return null;
  } catch {
    return null;
  }
}

function objectToFields(
  properties: Record<string, { type?: string; format?: string }>,
  required: Set<string>,
  exclude: Set<string>,
): DefinerField[] {
  const fields: DefinerField[] = [];
  for (const [name, def] of Object.entries(properties)) {
    if (exclude.has(name)) continue;
    let type: DefinerField['type'];
    if (def.type === 'number') type = 'number';
    else if (def.type === 'boolean') type = 'boolean';
    else if (def.type === 'string' && def.format === 'date-time') type = 'date';
    else if (def.type === 'string') type = 'string';
    else return []; // 못 표현하는 타입 — 안전하게 고급 전용으로 위에서 처리(호출부가 형태 검사).
    fields.push({ id: makeId(), name, type, required: required.has(name) });
  }
  return fields;
}
