'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { ConfirmDialog } from '@/components/ds/dialog';
import { EmptyState } from '@/components/ds/empty-state';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { RowList, RowListItem } from '@/components/ds/row-list';
import { NativeSelect } from '@/components/ds/select';
import { OrgScreenTitle } from '@/components/organization/org-screen-title';
import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { pickEulReulJosa } from '@/lib/korean-particle';
import {
  GenerationConnectorRegisterForm,
  GENERATION_CONNECTOR_LOCATIONS,
} from '@/components/organization/generation-connector-register-form';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

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
 * story #4166(3호 실측, 2026-09-22) — 리전만 바꾸는 행 액션. 이전엔 자격 재발급·
 * 재등록·재바인딩·구 커넥터 해지 4단계가 필요했다. select를 바로 PATCH에 걸어
 * 즉시 반영(등록 폼의 별도 «저장» 버튼과 다르게, 행 안에서 값 자체가 액션) —
 * active 커넥터에만 보인다(revoked는 BE가 409로 거부, #4166 서비스 계층).
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
  // story #4140 — 제품 정책값(crew 재량 0). model_config_json에 location 키가 없는
  // 기존 커넥터도 BE가 "global"로 해소해 이 필드는 항상 채워져 있다.
  location: string;
  status: string;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

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
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)

  const [connectors, setConnectors] = useState<GenerationConnector[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [registering, setRegistering] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; label: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [locationPatchTargetId, setLocationPatchTargetId] = useState<string | null>(null);
  const [locationPatchError, setLocationPatchError] = useState<string | null>(null);
  // story #4166 CHANGES-1(페드루 PO 리뷰) — controlled select가 c.location(서버값)만
  // 직접 참조하면 PATCH 응답이 오기 전에 이전 값으로 그대로 남아 있다가(리렌더 트리거가
  // 없어 "튐"으로 보이는 게 아니라, 사용자가 고른 값이 화면에 전혀 안 보이고 응답 뒤에야
  // 한 번에 바뀐다) — 낙관적 draft를 별도로 들고 select 값을 draft 우선으로 읽는다.
  const [locationDraft, setLocationDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!orgId) { setStatus('loaded'); return; }
    setStatus('loading');
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

  const handleLocationChange = async (connectorId: string, location: string) => {
    if (!orgId) return;
    setLocationPatchTargetId(connectorId);
    setLocationPatchError(null);
    setLocationDraft((prev) => ({ ...prev, [connectorId]: location }));
    try {
      const res = await fetchWithAuth(
        `/api/organizations/${orgId}/generation-connectors/${connectorId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location }),
        },
      );
      // story #4166 — 다른 탭이 먼저 해지한 경합(409)까지 코드별로 나누지 않는다(select
      // 값 자체가 허용 목록이라 422는 정상 흐름에서 안 남 — 남는 경우는 전부 "그 사이
      // 상태가 바뀜" 부류라 reload로 실제 상태를 보여주는 편이 정확). 네트워크 예외(catch)도
      // 동형 — 실패 사유 무관하게 실제 서버 상태를 다시 읽어야 한다(CHANGES-1: 이전엔
      // catch 경로에서 load()를 빠뜨려 요청이 실제로 갔는데 실패만 표시하고 화면은 그대로
      // "성공한 척"으로 남는 자리가 있었다).
      if (!res.ok) setLocationPatchError(t('gcLocationChangeError'));
    } catch {
      setLocationPatchError(t('gcLocationChangeError'));
    } finally {
      // draft는 load()가 실 서버값을 connectors에 반영한 뒤에만 지운다 — 먼저 지우면
      // select가 옛 c.location으로 한 프레임 되돌아갔다 다시 바뀌는 튐이 재발한다.
      await load();
      setLocationPatchTargetId(null);
      setLocationDraft((prev) => {
        if (!(connectorId in prev)) return prev;
        const next = { ...prev };
        delete next[connectorId];
        return next;
      });
    }
  };

  return (
    <>
      {/* 4913 — 제목은 위 막대, 본문은 한 쪽 틀(reading). 이름은 «생성 연결»(PO 11-12 · 옛 «연산 커넥터»). */}
      <OrgScreenTitle>{t('gcTitle')}</OrgScreenTitle>
      <PageFrame width="reading">
        <PageHead
          description={t('gcDescription')}
          actions={isOwnerOrAdmin && connectors.length > 0 && !registering ? (
            <Button variant="primary" onClick={() => setRegistering(true)} data-testid="gc-register-action">{t('gcRegisterAction')}</Button>
          ) : undefined}
        />

        {/* story #4116 — 못 쓰는 컨트롤은 비활성이 아니라 안 그림 + muted 사유(형제 화면 동일 규율). 목록 자체는 사람 org 멤버 전원이 본다(BE _require_human). */}
        {!isOwnerOrAdmin ? (
          <div data-testid="gc-owner-only-reason"><Banner tone="info">{t('gcOwnerOnlyReason')}</Banner></div>
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

        {locationPatchError ? <Banner tone="failed">{locationPatchError}</Banner> : null}

        {status === 'failed' ? (
          <Banner tone="failed" action={<Button variant="secondary" onClick={load}>{t('eventApplyAgentsRetry')}</Button>}>
            {t('gcListLoadError')}
          </Banner>
        ) : status === 'loaded' && connectors.length === 0 ? (
          <Card>
            <EmptyState
              title={t('gcEmptyTitle')}
              description={t('gcEmptyDesc')}
              action={isOwnerOrAdmin && !registering ? (
                <Button variant="primary" onClick={() => setRegistering(true)} data-testid="gc-first-register-action">{t('gcFirstRegisterAction')}</Button>
              ) : undefined}
            />
          </Card>
        ) : status === 'loaded' ? (
          <RowList aria-label={t('gcTitle')}>
            {connectors.map((c, index) => {
              // story #4116 — model_config_json은 provider마다 자유 형식이라(§3-1 "공급자 편애 없이") 값 있는 키 개수만 센다(어느 모달리티인지는 등록 폼에서 이미 봄, 목록 행은 요약 1줄).
              const modalityCount = Object.values(c.model_config_json ?? {})
                .filter((v) => typeof v === 'string' && v.trim().length > 0).length;
              const canEdit = isOwnerOrAdmin && c.status === 'active';
              return (
                <RowListItem
                  key={c.id}
                  data-testid="gc-row"
                  // 이름 + 제공자 + 리전 + 상태가 한 줄에 서되 좁은 화면에서는 줄바꿈(제목 칸의 한 줄 말줄임을 이 글 상자가 되살린다).
                  title={
                    <span className="flex flex-wrap items-center gap-2 whitespace-normal">
                      <span>{c.label}</span>
                      <Chip mono>{c.provider_key}</Chip>
                      {/* story #4140 — 제품 리전 정책값 가시화(crew가 이 값으로만 호출). story #4166 — owner/admin·active 커넥터는 칩 대신 select(값 자체가 즉시-적용 행 액션, 자격 무접촉). 그 외는 읽기전용 칩. */}
                      {canEdit ? (
                        <NativeSelect
                          className="w-40"
                          aria-label={t('gcLocationChangeAriaLabel', { n: index + 1, label: c.label })}
                          data-testid={`gc-location-select-${c.id}`}
                          value={locationDraft[c.id] ?? c.location}
                          disabled={locationPatchTargetId === c.id}
                          onChange={(e) => void handleLocationChange(c.id, e.target.value)}
                        >
                          {GENERATION_CONNECTOR_LOCATIONS.map((loc) => (
                            <option key={loc} value={loc}>{loc}</option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Chip mono data-testid="gc-location-chip">{c.location}</Chip>
                      )}
                      <Chip tone={c.status === 'active' ? 'done' : 'failed'} dot data-status-chip={c.status}>
                        {c.status === 'active' ? t('gcStatusActive') : t('gcStatusRevoked')}
                      </Chip>
                    </span>
                  }
                  subtitle={
                    <div className="space-y-0.5 whitespace-normal break-keep font-sans [overflow-wrap:anywhere]">
                      {modalityCount > 0 ? <p className="m-0">{t('gcModelCountSummary', { count: modalityCount })}</p> : null}
                      {/* story #4117 FE 라이더 — #4112 시안 프레임①의 "등록 시각" 행. 해지된 커넥터는 해지 시각도 같이(자격 소실 시점을 확認할 수 있게). */}
                      <p className="m-0">
                        {t('gcRegisteredAt', { time: formatViewerRelativeTime(c.created_at, locale, displayTimezone) })}
                        {c.status === 'revoked' && c.revoked_at
                          ? ` · ${t('gcRevokedAt', { time: formatViewerRelativeTime(c.revoked_at, locale, displayTimezone) })}`
                          : null}
                      </p>
                      {/* story #4166 CHANGES-1 — 등록 폼의 gcLocationHint 재사용(새 문구 발명 0), select가 뜨는 행에서만. */}
                      {canEdit ? <p className="m-0">{t('gcLocationHint')}</p> : null}
                    </div>
                  }
                  trailing={canEdit ? (
                    <Button
                      variant="danger"
                      onClick={() => setRevokeTarget({ id: c.id, label: c.label })}
                      data-testid={`gc-revoke-${c.id}`}
                      // story #4116 CI RED — 행마다 같은 정적 라벨("해지")뿐이면 스크린리더가 항목을 못 가른다(순번+그 행의 현재 라벨 · verify-repeated-row-action-names).
                      aria-label={t('gcRevokeAriaLabel', { n: index + 1, label: c.label })}
                    >
                      {t('gcRevokeAction')}
                    </Button>
                  ) : undefined}
                />
              );
            })}
          </RowList>
        ) : null}

        {/* story #4116(시안 §4) — 해지는 자격 소실+레시피 영향이라(채널의 인라인 해제와 다르게) 확認 다이얼로그를 둔다. */}
        <ConfirmDialog
          open={revokeTarget !== null}
          onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
          title={t('gcRevokeConfirmTitle', {
            name: revokeTarget?.label ?? '',
            // story #4117 FE 라이더 — 조사를 문자열에 고정하지 않고 pickEulReulJosa로 값의 받침 유무에 맞춘다.
            josa: pickEulReulJosa(revokeTarget?.label ?? ''),
          })}
          description={t('gcRevokeConfirmBody')}
          cancelLabel={tc('cancel')}
          confirmLabel={t('gcRevokeAction')}
          tone="danger"
          onConfirm={() => void handleRevoke()}
          loading={revoking}
        />
      </PageFrame>
    </>
  );
}
