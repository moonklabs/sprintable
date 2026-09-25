'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { buildApproverPickerOptions } from '@/lib/approver-picker-options';
import { memberLookup } from '@/lib/member-display';
import { fetchWithAuth } from '@/lib/db/client';
import { useMemberNameFallback } from '@/hooks/use-member-name-fallback';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { cn } from '@/lib/utils';

/**
 * story e0c1b24c — org 게이트 정책(posture·merge_gate_default_approver_member_id) 설정
 * UI. 백엔드(backend/app/routers/hitl_config.py GET/PUT /api/v2/gate-config/policy)는
 * #3319/PR#3716로 이미 착지했으나, 이 값을 넣을 화면/BFF 경로가 0이었다 — 이 컴포넌트가
 * 그 자리(BFF는 app/api/gate-config/policy/route.ts). GateLevelMatrix(S-GATE-4, work_type
 * ×actor_type 매트릭스)와는 별개 개념(posture=전역 판정 태세·기본 승인자=merge 게이트
 * 미지정 시 폴백)이라 별도 SectionCard로 둔다 — 같은 canEdit 규약(org owner/admin)만 공유.
 *
 * 승인자 픽커는 approval-request-card.tsx::DelegateApprovalControl과 동일 소스
 * (/api/org-members/eligible-approvers + buildApproverPickerOptions + OperatorDropdownSelect,
 * story #3040 v3 단일 소스 원칙 재사용 — 새 픽커 로직 발명 0).
 *
 * story #4083 — recipe_gate_default_approver_member_id 필드 1칸 추가(merge 칸과 완전
 * 동형 — 같은 eligible-approvers 목록·같은 저장 흐름·같은 human-only 422 문구 표시).
 * "org_owner 하드코딩" 실사고 처방(org owner≠마케팅 담당인 org에서 레시피 사람 게이트가
 * 전부 owner 결재함으로만 가던 것).
 */

type Posture = 'conservative' | 'balanced' | 'permissive';
const POSTURES: Posture[] = ['conservative', 'balanced', 'permissive'];
const POSTURE_LABEL_KEY: Record<Posture, 'postureConservative' | 'postureBalanced' | 'posturePermissive'> = {
  conservative: 'postureConservative',
  balanced: 'postureBalanced',
  permissive: 'posturePermissive',
};

interface OrgGatePolicyResponse {
  id: string;
  org_id: string;
  posture: string;
  merge_gate_default_approver_member_id: string | null;
  recipe_gate_default_approver_member_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EligibleApprover {
  id: string;
  user_id: string | null;
  name?: string | null;
  email?: string | null;
  role: 'owner' | 'admin' | 'member';
}

interface OrgGatePolicySectionProps {
  canEdit: boolean;
}

export function OrgGatePolicySection({ canEdit }: OrgGatePolicySectionProps) {
  const t = useTranslations('orgGatePolicy');
  const tc = useTranslations('common');
  const [loading, setLoading] = useState(true);
  const [posture, setPosture] = useState<Posture>('balanced');
  const [approverId, setApproverId] = useState<string>(''); // '' = 미지정(현행)
  const [recipeApproverId, setRecipeApproverId] = useState<string>(''); // '' = 미지정(현행, org owner)
  const [approverOptions, setApproverOptions] = useState<SelectOption[]>([]);
  const [loadingApprovers, setLoadingApprovers] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetchWithAuth('/api/gate-config/policy');
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: OrgGatePolicyResponse | null } | null;
          const policy = json?.data;
          if (policy) {
            if ((POSTURES as string[]).includes(policy.posture)) setPosture(policy.posture as Posture);
            setApproverId(policy.merge_gate_default_approver_member_id ?? '');
            setRecipeApproverId(policy.recipe_gate_default_approver_member_id ?? '');
          }
        } else {
          setMessage({ type: 'error', text: t('loadFailed') });
        }
      } catch {
        if (!cancelled) setMessage({ type: 'error', text: t('loadFailed') });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // canEdit 여부와 무관하게 조회한다 — 읽기전용 뷰에서도 지정된 승인자의 표시이름을
    // 풀어야 한다(id만 보여주면 admin이 아닌 owner도 못 알아본다). eligible-approvers는
    // org 멤버 누구나 호출 가능(관리자 전용 아님, backend/app/routers/org_members.py 실측).
    let cancelled = false;
    async function loadApprovers() {
      setLoadingApprovers(true);
      try {
        const res = await fetchWithAuth('/api/org-members/eligible-approvers');
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: EligibleApprover[] } | null;
          const { options } = buildApproverPickerOptions(json?.data ?? [], undefined, { unnamed: tc('memberUnnamed') });
          setApproverOptions(options);
        }
      } finally {
        if (!cancelled) setLoadingApprovers(false);
      }
    }
    void loadApprovers();
    return () => {
      cancelled = true;
    };
    // [SID:4286] tc(이름 없는 후보 라벨)는 로케일이 같으면 같은 함수 — 조회는 사실상 한 번 그대로.
  }, [tc]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetchWithAuth('/api/gate-config/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          posture,
          merge_gate_default_approver_member_id: approverId || null,
          recipe_gate_default_approver_member_id: recipeApproverId || null,
        }),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: t('saved') });
      } else {
        // story e0c1b24c AC — 승인자 검증 422 문구가 화면에 그대로 나와야 한다(backend/
        // app/routers/hitl_config.py의 human-only 검증 메시지, HTTPException.detail).
        // merge·레시피 필드 둘 다 이 관례 그대로 — 문구 자체가 사람 문장이어야 하는 책임은
        // 이 컴포넌트가 아니라 BE 카탈로그(i18n_catalog.py, story #4083 정정) 쪽에 있다.
        const body = (await res.json().catch(() => null)) as { detail?: string; error?: { message?: string } } | null;
        setMessage({ type: 'error', text: body?.detail ?? body?.error?.message ?? t('saveFailed') });
      }
    } catch {
      setMessage({ type: 'error', text: t('saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const approverSelectOptions: SelectOption[] = [{ value: '', label: t('approverUnset') }, ...approverOptions];
  // [SID:4286] 지정 승인자가 후보(owner/admin)에 없을 때 UUID 통째를 이름 칸에 싣던 것 — 후보 목록을 다 불러왔으면
  // «알 수 없는 구성원», 불러오는 중이면 빈 칸(자리 칸이 «불러오는 중» placeholder를 이미 보인다).
  const approverLabelTable = Object.fromEntries(approverOptions.map((o) => [o.value, o.label])) as Record<string, string>;
  // [SID:4300] 후보(owner/admin · 고르는 목록)에 없는 지정 승인자 — 역할이 바뀐 사람 등 — 도 조직 범위로 이름을 채운다(아는 사람을
  // «알 수 없는 구성원»이라 하지 않게). 고르는 목록은 후보 그대로.
  const { orgId } = useDashboardContext();
  const approverNames = useMemberNameFallback(orgId, approverLabelTable, [approverId, recipeApproverId], !loadingApprovers);
  const currentApproverLabel = approverId
    ? (memberLookup(approverNames.memberMap, approverId, tc, { loaded: approverNames.loaded })?.label ?? '')
    : t('approverUnset');
  const currentRecipeApproverLabel = recipeApproverId
    ? (memberLookup(approverNames.memberMap, recipeApproverId, tc, { loaded: approverNames.loaded })?.label ?? '')
    : t('approverUnset');

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
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

        {loading ? (
          <div className="space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-7 w-64 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('postureLabel')}</p>
              {canEdit ? (
                <div className="flex gap-1" role="group" aria-label={t('postureLabel')}>
                  {POSTURES.map((p) => (
                    <Button
                      key={p}
                      type="button"
                      variant="glass"
                      size="sm"
                      disabled={saving}
                      onClick={() => setPosture(p)}
                      className={cn(
                        'min-w-[80px]',
                        posture === p
                          ? 'border-primary bg-primary-tint text-foreground'
                          : 'border-border text-muted-foreground hover:bg-muted/40',
                      )}
                    >
                      {t(POSTURE_LABEL_KEY[p])}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t(POSTURE_LABEL_KEY[posture])}</p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('approverLabel')}</p>
              {canEdit ? (
                <OperatorDropdownSelect
                  value={approverId}
                  onValueChange={setApproverId}
                  options={approverSelectOptions}
                  placeholder={loadingApprovers ? t('approverLoading') : t('approverPickPlaceholder')}
                  disabled={loadingApprovers || saving}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{currentApproverLabel}</p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('recipeApproverLabel')}</p>
              {canEdit ? (
                <OperatorDropdownSelect
                  value={recipeApproverId}
                  onValueChange={setRecipeApproverId}
                  options={approverSelectOptions}
                  placeholder={loadingApprovers ? t('approverLoading') : t('approverPickPlaceholder')}
                  disabled={loadingApprovers || saving}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{currentRecipeApproverLabel}</p>
              )}
            </div>

            {canEdit ? (
              <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving ? tc('saving') : t('save')}
              </Button>
            ) : null}
          </>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
