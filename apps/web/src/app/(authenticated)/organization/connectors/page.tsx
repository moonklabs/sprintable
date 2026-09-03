'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story 4180f67f — 조직 커넥터 설정 화면. story #3317(레지스트리 API)이 서버·플러그인
 * MCP까지 닫았으나 웹 화면이 없어, 비개발 조직 담당자는 어디서 무엇을 채우는지 볼 자리가
 * 없었다. connector_key는 하드코딩하지 않는다(PO 명시 기각 — 다른 조직이 자체 커넥터를
 * register_connector_schema로 올려도 이 화면에 뜨게, 신설 GET /organizations/{id}/
 * connectors 목록으로 카드를 그린다). 시크릿은 이 화면에 절대 안 실린다 — requires_env는
 * 이름만 보여주고 값 입력 UI 자체가 없다(#3317 원칙, connector-schema.ts 서버 쪽 이중가드
 * 와 동형).
 *
 * apply warnings 딥링크는 이번 스코프 밖(PO 확定, 2026-09-02) — events.py의 apply
 * warnings가 구조화 안 된 문자열 배열이라(setup_hint 필드가 그 안에 없음) 지금은 카드
 * 자체에 "미충족 필수 필드" 배지만 표시한다. 구조화는 별도 스토리(PO 등재 예정).
 */

interface ConnectorField {
  name: string;
  source: 'content' | 'org_config';
  type?: string | null;
  required?: boolean | null;
  constraints?: { maxLength?: number; minLength?: number; pattern?: string; itemType?: 'string' | 'number' } | null;
  setup_hint?: string | null;
}

interface ConnectorResponse {
  connector_key: string;
  version: string;
  channel: string;
  fields: ConnectorField[];
  requires_env: string[];
  kinds: string[] | null;
  org_config: Record<string, unknown>;
}

function missingRequiredFieldNames(connector: ConnectorResponse): string[] {
  return connector.fields
    .filter((f) => f.source === 'org_config' && f.required)
    .filter((f) => {
      const v = connector.org_config[f.name];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.name);
}

function valueToInputText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function parseInputForField(raw: string, field: ConnectorField): unknown {
  if (field.type === 'array') {
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return field.constraints?.itemType === 'number' ? items.map(Number) : items;
  }
  if (field.type === 'number') return Number(raw);
  return raw;
}

type T = ReturnType<typeof useTranslations>;

function ConnectorCard({
  connector, orgId, isAdmin, t,
}: {
  connector: ConnectorResponse;
  orgId: string;
  isAdmin: boolean;
  t: T;
}) {
  const contentFields = connector.fields.filter((f) => f.source === 'content');
  const configFields = connector.fields.filter((f) => f.source === 'org_config');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(configFields.map((f) => [f.name, valueToInputText(connector.org_config[f.name])])),
  );
  const [savedConfig, setSavedConfig] = useState(connector.org_config);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const missing = missingRequiredFieldNames({ ...connector, org_config: savedConfig });

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const config: Record<string, unknown> = {};
      for (const f of configFields) {
        const raw = values[f.name];
        if (raw === undefined || raw === '') continue; // 빈 값은 전송 안 함 — 서버는 병합만(기존 값 보존).
        config[f.name] = parseInputForField(raw, f);
      }
      const res = await fetchWithAuth(`/api/organizations/${orgId}/connectors/${connector.connector_key}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: ConnectorResponse } | null;
        if (json?.data) setSavedConfig(json.data.org_config);
        setMessage({ type: 'success', text: t('connectorsSaved') });
      } else {
        const body = (await res.json().catch(() => null)) as { detail?: string; error?: { message?: string } } | null;
        setMessage({ type: 'error', text: body?.detail ?? body?.error?.message ?? t('connectorsSaveFailed') });
      }
    } catch {
      setMessage({ type: 'error', text: t('connectorsSaveFailed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-sm font-semibold text-foreground">{connector.connector_key}</h2>
            <Badge variant="outline">v{connector.version}</Badge>
            <Badge variant="secondary">{connector.channel}</Badge>
            {(connector.kinds ?? []).map((k) => <Badge key={k} variant="outline">{k}</Badge>)}
          </div>
          {missing.length > 0 ? (
            <Badge variant="warning">{t('connectorsMissingRequiredBadge', { fields: missing.join(', ') })}</Badge>
          ) : null}
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          <Alert
            variant={message.type === 'success' ? 'success' : 'destructive'}
            role={message.type === 'success' ? 'status' : 'alert'}
            aria-live={message.type === 'success' ? 'polite' : 'assertive'}
            aria-atomic="true"
          >
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        {connector.requires_env.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('connectorsRequiresEnvLabel')}</p>
            <div className="flex flex-wrap gap-1">
              {connector.requires_env.map((name) => <Badge key={name} variant="outline" className="font-mono">{name}</Badge>)}
            </div>
            <p className="text-[11px] text-muted-foreground">{t('connectorsRequiresEnvHint')}</p>
          </div>
        ) : null}

        {contentFields.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('connectorsContentFieldsLabel')}</p>
            <div className="flex flex-wrap gap-1">
              {contentFields.map((f) => <Badge key={f.name} variant="secondary" className="font-mono">{f.name}</Badge>)}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('connectorsConfigFieldsLabel')}</p>
          {configFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('connectorsConfigEmpty')}</p>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {configFields.map((f) => (
                <div key={f.name} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                  <span className="min-w-[140px] shrink-0 font-mono text-foreground">{f.name}</span>
                  <Badge variant={f.required ? 'outline' : 'secondary'} className="shrink-0">
                    {f.required ? t('connectorsFieldRequired') : t('connectorsFieldOptional')}
                  </Badge>
                  {isAdmin ? (
                    <input
                      type="text"
                      value={values[f.name] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                      disabled={saving}
                      className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                    />
                  ) : (
                    <span className="flex-1 text-muted-foreground">
                      {valueToInputText(savedConfig[f.name]) || t('connectorsUnset')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {isAdmin && configFields.length > 0 ? (
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? t('connectorsSavingCta') : t('connectorsSaveCta')}
          </Button>
        ) : null}
      </SectionCardBody>
    </SectionCard>
  );
}

export default function OrganizationConnectorsPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isAdmin = currentRole === 'admin' || currentRole === 'owner';
  const t = useTranslations('organization');

  const [connectors, setConnectors] = useState<ConnectorResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/connectors`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: ConnectorResponse[] } | null;
          setConnectors(json?.data ?? []);
        } else {
          setLoadError(true);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('connectorsTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('connectorsDescription')}</p>
      </div>

      {/* story #3376(PO 확定) — 소셜 채널 OAuth 연결은 주체·수명이 달라 별도 라우트
       * (/organization/channels)로 분리됐다. 이 페이지 자체는 손대지 않고 링크 한 줄만. */}
      <p className="text-sm text-muted-foreground">
        {t.rich('connectorsChannelsLinkHint', {
          link: (chunks) => <Link href="/organization/channels" className="text-foreground underline">{chunks}</Link>,
        })}
      </p>

      {!isAdmin ? <p className="text-sm text-muted-foreground">{t('connectorsReadonlyNotAdmin')}</p> : null}

      {loadError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('connectorsLoadFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : connectors.length === 0 ? (
        !loadError ? <p className="text-sm text-muted-foreground">{t('connectorsEmpty')}</p> : null
      ) : (
        <div className="space-y-4">
          {connectors.map((c) => (
            orgId ? <ConnectorCard key={c.connector_key} connector={c} orgId={orgId} isAdmin={isAdmin} t={t} /> : null
          ))}
        </div>
      )}
    </div>
  );
}
