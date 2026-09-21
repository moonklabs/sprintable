'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { pickEulReulJosa } from '@/lib/korean-particle';
import { GenerationConnectorRegisterForm } from '@/components/organization/generation-connector-register-form';

/**
 * story #4116(#4112 유나 시안 55a04e8d 승인본, PO 승인 2026-09-21 15:05Z) — 연산
 * 커넥터 설정 화면. `/organization/channels`(채널 연결)의 형제 화면 — 같은
 * PageHeader+max-w-3xl Card 목록 패턴·상태칩(§⑥-2: tint bg+solid dot+text-foreground)·
 * 자격 붙여넣기(pasted-secret 규율)·권한 못 쓰면 안 그림+muted 사유. 다른 점(시안 §8
 * 명시)은 ①해지에 확認 다이얼로그(자격 소실+레시피 영향, 채널은 인라인) ②identity=
 * 이름+provider 배지(계정 라벨이 없다) ③모달리티별 모델 id 3칸.
 *
 * BFF는 #4101에 이미 있다(GET 목록·POST 등록·POST revoke) — 이 PR은 BE/BFF 무변,
 * 있는 것만 소비한다.
 *
 * story #4117 FE 라이더(#4116 화면 위, PR #4492가 이미 착지시킨 BE DTO의
 * created_at/revoked_at 소비) — #4116 최초 구현 당시엔 응답 DTO에 그 두 필드가
 * 없어 "등록 시각" 행을 생략했다(위 주석 원문 그대로 보존, 그 발견이 이 라이더의
 * 근거). #4117-BE가 필드를 추가했으니 이제 소비한다.
 */
interface GenerationConnector {
  id: string;
  provider_key: string;
  label: string;
  model_config_json: Record<string, unknown>;
  status: string;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

const STATUS_TONE: Record<string, { bg: string; dot: string; text: string }> = {
  active: { bg: 'bg-success-tint', dot: 'bg-success', text: 'text-foreground' },
  revoked: { bg: 'bg-destructive-tint', dot: 'bg-destructive', text: 'text-foreground' },
};

export default function OrganizationGenerationConnectorsPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  // story #4116 — org_generation_connectors.py 권한 그대로(list=_require_human 전원·
  // create/revoke=_require_org_admin) — channels/page.tsx의 isOwnerOrAdmin과 동형.
  const isOwnerOrAdmin = currentRole === 'owner' || currentRole === 'admin';
  const t = useTranslations('organization');
  const tc = useTranslations('common');
  const tChannel = useTranslations('channelConnect');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  const [connectors, setConnectors] = useState<GenerationConnector[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [registering, setRegistering] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; label: string } | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(() => {
    if (!orgId) { setStatus('loaded'); return; }
    setStatus('loading');
    void (async () => {
      try {
        // active_only=false — 목록 화면은 해지된 것도 보여준다(시안 프레임①, revoked 칩).
        const res = await fetchWithAuth(`/api/organizations/${orgId}/generation-connectors?active_only=false`);
        if (!res.ok) { setStatus('failed'); return; }
        const json = await res.json() as { data?: { connectors?: GenerationConnector[] } };
        setConnectors(json.data?.connectors ?? []);
        setStatus('loaded');
      } catch {
        setStatus('failed');
      }
    })();
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async () => {
    if (!revokeTarget || !orgId) return;
    setRevoking(true);
    try {
      const res = await fetchWithAuth(
        `/api/organizations/${orgId}/generation-connectors/${revokeTarget.id}/revoke`,
        { method: 'POST' },
      );
      if (res.ok) load();
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader
        title={t('gcTitle')}
        description={t('gcDescription')}
        actions={isOwnerOrAdmin && connectors.length > 0 && !registering ? (
          <Button onClick={() => setRegistering(true)} data-testid="gc-register-action">{t('gcRegisterAction')}</Button>
        ) : undefined}
      />

      {/* story #4116 — 못 쓰는 컨트롤은 비활성이 아니라 안 그림 + muted 사유(형제 화면
          동일 규율). 목록 자체는 사람 org 멤버 전원이 본다(BE _require_human). */}
      {!isOwnerOrAdmin ? (
        <p className="rounded-md border border-input bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="gc-owner-only-reason">
          {t('gcOwnerOnlyReason')}
        </p>
      ) : null}

      {registering && isOwnerOrAdmin && orgId ? (
        <GenerationConnectorRegisterForm
          orgId={orgId}
          onRegistered={() => { setRegistering(false); load(); }}
          onCancel={() => setRegistering(false)}
          t={t}
          tc={tc}
          tChannel={tChannel}
        />
      ) : null}

      {status === 'failed' ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t('gcListLoadError')}</span>
            <Button variant="outline" size="sm" onClick={load}>{t('eventApplyAgentsRetry')}</Button>
          </AlertDescription>
        </Alert>
      ) : status === 'loaded' && connectors.length === 0 ? (
        <EmptyState
          title={t('gcEmptyTitle')}
          description={t('gcEmptyDesc')}
          action={isOwnerOrAdmin && !registering ? (
            <Button onClick={() => setRegistering(true)} data-testid="gc-first-register-action">{t('gcFirstRegisterAction')}</Button>
          ) : undefined}
        />
      ) : status === 'loaded' ? (
        <Card className="divide-y divide-border overflow-hidden">
          {connectors.map((c, index) => {
            const tone = STATUS_TONE[c.status] ?? STATUS_TONE.active!;
            // story #4116 — model_config_json은 provider마다 자유 형식이라(§3-1 "공급자
            // 편애 없이") 값 있는 키 개수만 센다(어느 모달리티인지는 등록 폼에서 이미
            // 봄, 목록 행은 요약 1줄).
            const modalityCount = Object.values(c.model_config_json ?? {})
              .filter((v) => typeof v === 'string' && v.trim().length > 0).length;
            return (
              <div key={c.id} className="flex items-center gap-3 p-4" data-testid="gc-row">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    <span>{c.label}</span>
                    <span className="rounded border border-input bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {c.provider_key}
                    </span>
                    <span
                      data-status-chip={c.status}
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
                    >
                      <span data-chip-dot className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                      {c.status === 'active' ? t('gcStatusActive') : t('gcStatusRevoked')}
                    </span>
                  </div>
                  {modalityCount > 0 ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t('gcModelCountSummary', { count: modalityCount })}
                    </p>
                  ) : null}
                  {/* story #4117 FE 라이더 — #4112 시안 프레임①의 "등록 시각" 행.
                      해지된 커넥터는 해지 시각도 같이(자격 소실 시점을 확認할 수 있게). */}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t('gcRegisteredAt', { time: formatRelativeTime(c.created_at, locale, displayTimezone) })}
                    {c.status === 'revoked' && c.revoked_at
                      ? ` · ${t('gcRevokedAt', { time: formatRelativeTime(c.revoked_at, locale, displayTimezone) })}`
                      : null}
                  </p>
                </div>
                {isOwnerOrAdmin && c.status === 'active' ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setRevokeTarget({ id: c.id, label: c.label })}
                    data-testid={`gc-revoke-${c.id}`}
                    // story #4116 CI RED(페드루 PO 지적, verify-repeated-row-action-names.ts
                    // story #3592) — 행마다 같은 정적 라벨("해지")뿐이면 스크린리더가 항목을
                    // 못 가른다. channels/page.tsx::channelRowActionAriaLabel과 동형(순번+
                    // 그 행의 현재 라벨).
                    aria-label={t('gcRevokeAriaLabel', { n: index + 1, label: c.label })}
                  >
                    {t('gcRevokeAction')}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </Card>
      ) : null}

      {/* story #4116(시안 §4) — 해지는 자격 소실+레시피 영향이라(채널의 인라인 해제와
          다르게) 확認 다이얼로그를 둔다. */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        title={t('gcRevokeConfirmTitle', {
          name: revokeTarget?.label ?? '',
          // story #4117 FE 라이더(유나 4491 앵커 비차단, 페드루 PO 확定) — 조사를
          // 문자열에 고정하지 않고(#4096류 재발) pickEulReulJosa로 값의 받침 유무에
          // 맞춘다(pickEunNeunJosa 계열과 동형 원칙).
          josa: pickEulReulJosa(revokeTarget?.label ?? ''),
        })}
        description={t('gcRevokeConfirmBody')}
        cancelLabel={tc('cancel')}
        confirmLabel={t('gcRevokeAction')}
        onConfirm={() => void handleRevoke()}
        confirmDisabled={revoking}
      />
    </div>
  );
}
