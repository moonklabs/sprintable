'use client';

import { Fragment, type ReactNode } from 'react';
import { useSampleText } from './use-sample-text';
import { useLocale, useTranslations } from 'next-intl';
import { EventBlockCard } from '@/components/chat/event-block-card';
import type { BlockTemplate, EventDefinitionSummary as EventDefinitionSummaryDef } from '@/lib/block-template';

// story #2677 — 정의 상세보기(펼침) 기본 뷰를 사람 언어로. PO review_changes(head cbb0ff0c) —
// 최초안은 필드 표·routing 요약·미리보기까지 전부 tryReverseParse(정의기 3서식 폼이 만들
// 수 있는 정확한 모양)에 묶여 있어, 프리셋 4종(키가 애초에 org.{slug}. 접두가 아니라 항상
// 실패)이 전부 JSON 그대로였다 — PO fix 지시: 폴백을 «서식(사이클/신호/측정) 분류» 한 줄로만
// 좁히고, 필드 표·routing 요약·실물 카드는 raw JSON에서 직접 읽어 역파생 없이 항상 그린다
// (payload_schema.properties/routing 두 leg/block_template은 이미 사람이 읽을 수 있는 형태의
// 구조화 데이터이지 정의기 폼 전용 모양이 아니다 — 그 사실을 활용).
// JSON Schema의 `type`은 문자열 하나이거나 유니언 배열(예: `["string", "null"]` — 비어도 되는 필드)이다.
// enum 값은 JSON 값 아무거나다(등록 API가 숫자 · 참거짓 enum도 받는다 — 까디르 4603 QA P1). 문자열로 좁혀 선언하면 tsc가
// 문자열 전용 처리(`.split`)를 못 잡는다.
type EnumValue = string | number | boolean | null;
type SchemaProperty = { type?: string | string[]; format?: string; enum?: EnumValue[] };

/** story #4246 — `null`을 뺀 실제 값 타입들. 비어도 되는지는 «필수/선택» 칸이 따로 말한다. */
function valueTypes(def: SchemaProperty): string[] {
  const raw = Array.isArray(def.type) ? def.type : def.type ? [def.type] : [];
  return raw.filter((type) => type !== 'null');
}

function classifyFormat(properties: Record<string, SchemaProperty>): 'cycle' | 'signal' | 'measure' | null {
  if ('stage' in properties && properties.stage?.enum) return 'cycle';
  if ('kind' in properties) return 'signal';
  if ('metric_value' in properties) return 'measure';
  return null;
}

function sampleValueForProperty(def: SchemaProperty, name: string, sampleText: (name: string) => string): unknown {
  // enum이 null로 시작해도(비어도 되는 선택지) 예시는 첫 실제 값.
  const firstValue = def.enum?.find((v) => v !== null);
  if (firstValue !== undefined) return firstValue;
  const type = valueTypes(def)[0];
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return true;
  if (type === 'string' && def.format === 'date-time') return new Date(0).toISOString();
  // story #4257 — en에서도 한국어 «예시 …»가 나오던 자리. 로케일 문구(organization.definerSampleValue).
  return sampleText(name);
}

/** story #4246(유나 design · 390) — 식별자(필드 이름 · enum 값)는 `_` 뒤에서만 줄을 바꿀 수 있게 `<wbr>`. 코드 칩은 한 덩어리라
 * `break-words`로는 표 열 최소 폭이 안 줄어 긴 이름이 표를 넓혔다. 복사되는 텍스트는 그대로(`<wbr>`은 글자가 아니다).
 * `overflow-wrap: anywhere`는 형식 칸을 한 글자 폭으로 무너뜨려 쓰지 않는다. */
export function breakableIdentifier(value: string): ReactNode {
  const parts = value.split('_');
  return parts.map((part, i) => (
    <Fragment key={i}>{part}{i < parts.length - 1 ? <>_<wbr /></> : null}</Fragment>
  ));
}

function valueTypeLabel(type: string, format: string | undefined, t: ReturnType<typeof useTranslations>): string {
  if (type === 'string' && format === 'date-time') return t('definerFieldTypeDate');
  if (type === 'string') return t('definerFieldTypeString');
  if (type === 'number' || type === 'integer') return t('definerFieldTypeNumber');
  if (type === 'boolean') return t('definerFieldTypeBoolean');
  if (type === 'array') return t('definerFieldTypeList');
  if (type === 'object') return t('definerFieldTypeObject');
  return t('definerFieldTypeOther'); // 알아볼 수 없는 형식 문자열만
}

// story #4246(유나 확정) — 형식 칸은 사람 말만. 예전엔 유니언 배열(`["string","null"]`)을 그대로 돌려줘 React가 «stringnull»로
// 이어 그렸고, enum은 내부어 «enum(…)», integer 등은 원문 그대로였다.
// - 유니언: `null`을 뺀 첫 형식의 라벨(«비어도 됨»은 옆 «필수/선택» 칸이 말한다).
// - enum: «다음 중 하나: …» — 값은 페이로드에 그대로 보낼 원문이라 번역하지 않고 값마다 `<code>`(줄이지 않고 칸 안에서 줄바꿈).
function fieldTypeLabel(def: SchemaProperty, t: ReturnType<typeof useTranslations>, locale: string): ReactNode {
  if (def.enum) {
    const values = def.enum.filter((v): v is Exclude<EnumValue, null> => v !== null);
    // 머리말(«다음 중 하나:» / «One of:») 뒤에 값 목록 — ko·en 모두 값이 문장 끝이라 메시지에 자리 태그를 두지 않는다.
    return (
      <>
        {t('definerFieldTypeEnum')}{' '}
        {values.map((value, i) => (
          <Fragment key={`${i}:${String(value)}`}>
            {i > 0 ? ', ' : null}
            {/* 식별자 줄바꿈은 문자열 값만 — 숫자 · 참거짓은 원문 그대로 */}
            <code className="rounded bg-muted px-1 font-mono text-[11px]">{typeof value === 'string' ? breakableIdentifier(value) : String(value)}</code>
          </Fragment>
        ))}
      </>
    );
  }
  // 까디르 4603 QA ① — 등록 API는 여러 형식 유니언(`["string","number"]`)도 받고 둘 다 검증하므로, 라벨도 null 아닌 형식
  // 전부를 «또는»으로 잇는다(첫 것만 쓰면 조직 정의에서 거짓 라벨). 시드엔 null 빼면 형식 하나인 유니언뿐이다.
  const labels = Array.from(new Set(valueTypes(def).map((type) => valueTypeLabel(type, def.format, t))));
  if (labels.length === 0) return t('definerFieldTypeAny'); // 형식 없음 = 아무 값이나 받는다
  // 유나 확정 — en은 문장 속이라 첫 낱말만 대문자(«Text or number» · «Text, number, or boolean»). ko는 그대로.
  const parts = locale.startsWith('en') ? labels.map((label, i) => (i === 0 ? label : label.toLocaleLowerCase(locale))) : labels;
  return new Intl.ListFormat(locale, { type: 'disjunction' }).format(parts);
}

// noRecipientLabel — 「받는 사람」(broadcast) 축과 「즉시 알림」(escalation) 축은 "없음"의
// 뉘앙스가 다르다: broadcast의 server_derived/none은 정의기가 이미 «기록만(알림 없음)»이라는
// 이름을 붙여 놓은 정확한 개념(definerRoutingRecordTitle)이고, escalation의 none은 단순히
// "이 leg는 안 씀"이라 범용 definerDerivedNone이 맞는다.
function summarizeRoutingLeg(
  leg: { kind?: string; target?: string } | undefined,
  t: ReturnType<typeof useTranslations>,
  noRecipientLabel: string,
): string {
  if (!leg) return noRecipientLabel;
  if (leg.kind === 'server_derived') {
    if (!leg.target || leg.target === 'none') return noRecipientLabel;
    if (leg.target === 'work_item_stakeholders') return t('definerRoutingStakeholdersTitle');
    if (leg.target === 'goal_owner') return t('eventRoutingTargetGoalOwner');
    return leg.target;
  }
  if (leg.kind === 'payload_field') return t('definerRoutingAssignTitle');
  return leg.kind ?? noRecipientLabel;
}

function isDefaultLeg(leg: { kind?: string; target?: string } | undefined): boolean {
  return !leg || (leg.kind === 'server_derived' && (!leg.target || leg.target === 'none'));
}

export function EventDefinitionSummary({
  payloadSchema, routing, actionAuth, blockTemplate, definition,
}: {
  payloadSchema: Record<string, unknown>;
  routing: Record<string, unknown>;
  actionAuth: Record<string, unknown> | null | undefined;
  blockTemplate: Record<string, unknown> | null;
  /** PR #4575 까디르 QA — 실물 카드 미리보기도 채팅과 같은 로케일 문안으로(플랫폼 프리셋 판별에 key·org_id·name). */
  definition?: EventDefinitionSummaryDef | null;
}) {
  const sampleText = useSampleText();
  const t = useTranslations('organization');
  const locale = useLocale();
  const properties = (payloadSchema.properties ?? {}) as Record<string, SchemaProperty>;
  const required = new Set((payloadSchema.required as string[] | undefined) ?? []);
  const fieldNames = Object.keys(properties);
  const format = classifyFormat(properties);

  const broadcast = routing.broadcast as { kind?: string; target?: string } | undefined;
  const escalation = routing.escalation as { kind?: string; target?: string } | undefined;
  const escalationSummary = isDefaultLeg(escalation) ? null : summarizeRoutingLeg(escalation, t, t('definerDerivedNone'));

  const auth = actionAuth as { human_only?: boolean; role?: string[] } | null | undefined;
  const authParts = [
    auth?.human_only ? t('definerAuthHumanOnlyLabel') : null,
    Array.isArray(auth?.role) && auth.role.length > 0 ? auth.role.join(', ') : null,
  ].filter((v): v is string => !!v);
  const authSummary = authParts.length > 0 ? authParts.join(' · ') : t('definerDerivedNone');

  const samplePayload: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(properties)) samplePayload[name] = sampleValueForProperty(def, name, sampleText);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-muted/30 p-3">
        <SummaryLine
          label={t('eventSummaryFormatLabel')}
          value={format ? t(`definerFormat_${format}`) : t('eventSummaryFormatUnclassified')}
        />
        <SummaryLine label={t('eventSummaryRoutingLabel')} value={summarizeRoutingLeg(broadcast, t, t('definerRoutingRecordTitle'))} />
        {escalationSummary ? <SummaryLine label={t('eventSummaryEscalationLabel')} value={escalationSummary} /> : null}
        <SummaryLine label={t('eventSummaryAuthLabel')} value={authSummary} />
      </div>

      <div>
        <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{t('eventSummaryFieldsLabel')}</p>
        {fieldNames.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('eventSummaryFieldsEmpty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 text-left text-[11px] font-semibold text-muted-foreground">
                  <th className="px-2 py-1">{t('definerFieldNameCol')}</th>
                  <th className="px-2 py-1">{t('definerFieldTypeCol')}</th>
                  <th className="px-2 py-1">{t('definerFieldRequiredCol')}</th>
                </tr>
              </thead>
              <tbody>
                {fieldNames.map((name) => (
                  <tr key={name} className="border-t border-border">
                    <td className="px-2 py-1 font-mono text-foreground" data-testid={`event-def-field-name-${name}`}>{breakableIdentifier(name)}</td>
                    <td className="break-words px-2 py-1 text-muted-foreground" data-testid={`event-def-field-type-${name}`}>{fieldTypeLabel(properties[name]!, t, locale)}</td>
                    {/* story #4223(유나) — 390 ko에서 «필수»가 «필/수»로 세로 접혔다 · 낱말 줄바꿈 금지(좁으면 다른 열이 양보). */}
                    <td className="whitespace-nowrap px-2 py-1 text-muted-foreground" data-testid={`event-def-field-required-${name}`}>
                      {required.has(name) ? t('definerFieldRequired') : t('definerFieldOptional')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {blockTemplate ? (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{t('definerPreviewLabel')}</p>
          {/* PR #4575 유나 반려 — 미리보기엔 실제 일감이 없어 `{{label.work_item_target}}`(플랫폼 프리셋 «대상»)이 ⟨missing⟩으로
              떴다. 채팅과 같은 refs 모양의 예시 일감을 넣어 «대상 · 예시 일감»으로 보인다. */}
          <EventBlockCard
            template={blockTemplate as unknown as BlockTemplate} payload={samplePayload} definition={definition}
            refs={{ work_item: { found: true, type: 'story', token: t('definerPreviewSampleWorkItem') } }}
          />
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer text-[11px] font-semibold text-muted-foreground">{t('definerTabAdvanced')}</summary>
        <div className="mt-2 space-y-2">
          <JsonPreview label={t('eventPayloadSchemaLabel')} value={payloadSchema} />
          <JsonPreview label={t('eventRoutingLabel')} value={routing} />
          {blockTemplate ? <JsonPreview label={t('eventBlockTemplateLabel')} value={blockTemplate} /> : null}
        </div>
      </details>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5 text-xs">
      <span className="min-w-[70px] shrink-0 font-semibold text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-foreground">{value}</span>
    </div>
  );
}

export function JsonPreview({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{label}</p>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs text-foreground">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
