'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { EventBlockCard } from '@/components/chat/event-block-card';
import type { BlockTemplate } from '@/lib/block-template';
import { deriveDefinition, tryReverseParse } from './event-definer-logic';

// story #2677 — 정의 상세보기(펼침) 기본 뷰를 사람 언어로. #2670의 정의기 파생/역파생
// 로직(tryReverseParse→deriveDefinition)을 «쓰기 폼» 용도 그대로 «읽기 요약» 용도로
// 재사용한다(A층 원칙 — 새 파생 규칙 발명 금지, 폼이 만들 수 있는 모양과 항상 동형이 보장됨).
// 역파생이 실패하면(프리셋 전부 포함 — key가 org.{slug}. 접두가 아니라 애초에 항상 실패,
// 혹은 폼이 못 만드는 모양으로 손편집된 커스텀 정의) 정의기 edit 다이얼로그와 같은 규칙으로
// «고급 전용» 배지+JSON 그대로 노출(정직 폴백 — 부분적으로 사람 언어를 흉내내지 않는다).
export function EventDefinitionSummary({
  eventKey, payloadSchema, routing, actionAuth, blockTemplate, orgSlug,
}: {
  eventKey: string;
  payloadSchema: Record<string, unknown>;
  routing: Record<string, unknown>;
  actionAuth: Record<string, unknown> | null | undefined;
  blockTemplate: Record<string, unknown> | null;
  orgSlug: string;
}) {
  const t = useTranslations('organization');
  const parsed = orgSlug
    ? tryReverseParse(eventKey, payloadSchema, routing, actionAuth ?? null, orgSlug, blockTemplate)
    : null;

  if (!parsed) {
    return (
      <div className="space-y-2">
        <Badge variant="warning" className="text-[10px]">{t('definerAdvancedOnlyBadge')}</Badge>
        <JsonPreview label={t('eventPayloadSchemaLabel')} value={payloadSchema} />
        <JsonPreview label={t('eventRoutingLabel')} value={routing} />
        {blockTemplate ? <JsonPreview label={t('eventBlockTemplateLabel')} value={blockTemplate} /> : null}
      </div>
    );
  }

  const derived = deriveDefinition(parsed, orgSlug);
  const properties = (derived.payload_schema.properties ?? {}) as Record<string, { type?: string; format?: string; enum?: string[] }>;
  const required = new Set((derived.payload_schema.required as string[] | undefined) ?? []);
  const fieldNames = Object.keys(properties);

  const auth = derived.action_auth as { human_only?: boolean; role?: string[] } | null;
  const authParts = [
    auth?.human_only ? t('definerAuthHumanOnlyLabel') : null,
    Array.isArray(auth?.role) && auth!.role!.length > 0 ? auth!.role!.join(', ') : null,
  ].filter((v): v is string => !!v);
  const authSummary = authParts.length > 0 ? authParts.join(' · ') : t('definerDerivedNone');

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-muted/30 p-3">
        <SummaryLine label={t('eventSummaryFormatLabel')} value={t(`definerFormat_${parsed.format}`)} />
        <SummaryLine
          label={t('eventSummaryRoutingLabel')}
          value={parsed.routing === 'assign_on_publish' ? t('definerRoutingAssignTitle') : t('definerRoutingRecordTitle')}
        />
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

      <div>
        <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{t('definerPreviewLabel')}</p>
        <EventBlockCard template={derived.block_template as BlockTemplate} payload={derived.samplePayload} />
      </div>

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

function fieldTypeLabel(def: { type?: string; format?: string; enum?: string[] }, t: ReturnType<typeof useTranslations>): string {
  if (def.enum) return `enum(${def.enum.join(', ')})`;
  if (def.type === 'string' && def.format === 'date-time') return t('definerFieldTypeDate');
  if (def.type === 'string') return t('definerFieldTypeString');
  if (def.type === 'number') return t('definerFieldTypeNumber');
  if (def.type === 'boolean') return t('definerFieldTypeBoolean');
  return def.type ?? '?';
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
