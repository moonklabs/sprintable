'use client';

import { useTranslations } from 'next-intl';
import { EventBlockCard } from '@/components/chat/event-block-card';
import type { BlockTemplate } from '@/lib/block-template';

// story #2677 — 정의 상세보기(펼침) 기본 뷰를 사람 언어로. PO review_changes(head cbb0ff0c) —
// 최초안은 필드 표·routing 요약·미리보기까지 전부 tryReverseParse(정의기 3서식 폼이 만들
// 수 있는 정확한 모양)에 묶여 있어, 프리셋 4종(키가 애초에 org.{slug}. 접두가 아니라 항상
// 실패)이 전부 JSON 그대로였다 — PO fix 지시: 폴백을 «서식(사이클/신호/측정) 분류» 한 줄로만
// 좁히고, 필드 표·routing 요약·실물 카드는 raw JSON에서 직접 읽어 역파생 없이 항상 그린다
// (payload_schema.properties/routing 두 leg/block_template은 이미 사람이 읽을 수 있는 형태의
// 구조화 데이터이지 정의기 폼 전용 모양이 아니다 — 그 사실을 활용).
type SchemaProperty = { type?: string; format?: string; enum?: string[] };

function classifyFormat(properties: Record<string, SchemaProperty>): 'cycle' | 'signal' | 'measure' | null {
  if ('stage' in properties && properties.stage?.enum) return 'cycle';
  if ('kind' in properties) return 'signal';
  if ('metric_value' in properties) return 'measure';
  return null;
}

function sampleValueForProperty(def: SchemaProperty, name: string): unknown {
  if (def.enum && def.enum.length > 0) return def.enum[0];
  if (def.type === 'number') return 0;
  if (def.type === 'boolean') return true;
  if (def.type === 'string' && def.format === 'date-time') return new Date(0).toISOString();
  return `예시 ${name}`;
}

function fieldTypeLabel(def: SchemaProperty, t: ReturnType<typeof useTranslations>): string {
  if (def.enum) return `enum(${def.enum.join(', ')})`;
  if (def.type === 'string' && def.format === 'date-time') return t('definerFieldTypeDate');
  if (def.type === 'string') return t('definerFieldTypeString');
  if (def.type === 'number') return t('definerFieldTypeNumber');
  if (def.type === 'boolean') return t('definerFieldTypeBoolean');
  return def.type ?? '?';
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
  payloadSchema, routing, actionAuth, blockTemplate,
}: {
  payloadSchema: Record<string, unknown>;
  routing: Record<string, unknown>;
  actionAuth: Record<string, unknown> | null | undefined;
  blockTemplate: Record<string, unknown> | null;
}) {
  const t = useTranslations('organization');
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
  for (const [name, def] of Object.entries(properties)) samplePayload[name] = sampleValueForProperty(def, name);

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
                    <td className="px-2 py-1 font-mono text-foreground">{name}</td>
                    <td className="px-2 py-1 text-muted-foreground">{fieldTypeLabel(properties[name]!, t)}</td>
                    <td className="px-2 py-1 text-muted-foreground">
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
          <EventBlockCard template={blockTemplate as unknown as BlockTemplate} payload={samplePayload} />
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
