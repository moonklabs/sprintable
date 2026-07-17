'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, CheckCircle, XCircle } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GateEvidence, gateNeedsAction, gateDecision } from '@/components/cage/gate-evidence';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { useSyntheticParentTabHistory } from '@/hooks/use-synthetic-parent-tab-history';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';

// story #1954(P1a-S4) — Gate 3종(게이트·문서결재·머지게이트) canonical 상세. P1a·P2 공용 유일
// per-gate 라우트(중복 빌드 봉쇄) — decision(inbox_items)은 별도 표면(오르테가군 PO 판단+
// 디디군·유나양 2줄검증 확定, 2026-07-17). #1951 매니페스트 target=gate_detail·parentTab=approvals.
//
// BE 계약(story #1970, 디디군, PR#2253 — 스레드 합의 shape 그대로 구현·까심 QA 중): `GET
// /api/v2/gates/{id}` 신설 — project_id(신규, resolve_work_item_project_id 재사용)·
// work_item_summary(doc=title+slug, story/task=title만+slug=null, 그 외=null) 응답. PR#2253
// 머지+배포 전까지 이 프록시는 404를 그대로 패스스루(notFound 상태로 자연 처리).
//
// ⚠️위험도(risk) 필드는 #1970 스코프 밖 — 여전히 미존재(gate.py에 risk_level 류 없음). "저·고위험
// =동일 BE 위험도 필드"(AC) 요구는 별도 후속 계약 논의 필요. 그때까지 riskLevel은 항상 'unknown'
// 으로 렌더되며(추측 배지 금지), 실 필드가 오면 deriveRiskLevel 한 곳만 교체하면 된다.
interface GateDetail extends GateItem {
  org_id: string;
  project_id?: string | null;
}

type RiskLevel = 'low' | 'high' | 'unknown';

// TODO(#1970): BE 위험도 필드 확定되면 그 필드를 그대로 매핑 — 추측 휴리스틱 금지.
function deriveRiskLevel(_gate: GateDetail): RiskLevel {
  return 'unknown';
}

export default function GateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations('cage');
  // 조직/프로젝트 식별(AC) — 현재 탭이 이미 로드해둔 멤버십 목록에서 이름 조회(신규 fetch 0).
  // 크로스 프로젝트 게이트(현재 탭 프로젝트가 아닌 경우)는 매칭 실패 → ID 스니펫 폴백(정직한 값).
  const { orgMemberships, projectMemberships } = useDashboardContext();
  // story #1959(P2-S3): 딥링크 매니페스트(gate_detail→parentTab=approvals) — 콜드 진입 시 "결재함"
  // 탭 루트를 BACK 대상으로 선주입. 결재함 목록에서 클릭해 온 경우(history.length>1)는 no-op.
  useSyntheticParentTabHistory('/inbox');

  const [gate, setGate] = useState<GateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [resolving, setResolving] = useState(false);

  const fetchGate = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const res = await fetch(`/api/gates/${id}`);
      if (res.status === 404) { setNotFound(true); return; }
      if (!res.ok) return;
      const json = await res.json();
      setGate((json?.data ?? json) as GateDetail);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void fetchGate(); }, [fetchGate]);

  const transition = useCallback(async (status: 'approved' | 'rejected', note?: string) => {
    if (!gate) return;
    setResolving(true);
    try {
      const res = await fetch(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note: note?.trim() || null }),
      });
      if (res.ok) router.push('/inbox');
    } finally {
      setResolving(false);
    }
  }, [gate, router]);

  return (
    <>
      <TopBarSlot
        title={
          <button
            type="button"
            onClick={() => router.push('/inbox')}
            className="flex flex-shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('gateDetailBackToInbox')}
          </button>
        }
      />
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-5">
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('gateInboxLoading')}</p>
        ) : notFound || !gate ? (
          <p className="text-sm text-muted-foreground">{t('gateDetailNotFound')}</p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="chip">{gate.gate_type}</Badge>
                {deriveRiskLevel(gate) === 'unknown' ? (
                  <Badge variant="outline" className="text-muted-foreground">{t('riskUnknown')}</Badge>
                ) : null}
              </div>
              <h1 className="text-base font-semibold text-foreground">
                {gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`}
              </h1>
              <p className="text-xs text-muted-foreground">
                {t('gateDetailOrgContext', {
                  org: orgMemberships.find((o) => o.orgId === gate.org_id)?.orgName ?? gate.org_id.slice(0, 8),
                })}
                {gate.project_id
                  ? ` · ${projectMemberships.find((p) => p.projectId === gate.project_id)?.projectName ?? gate.project_id.slice(0, 8)}`
                  : ''}
              </p>
            </div>

            {deriveRiskLevel(gate) === 'high' ? (
              <GateSignatureApproval
                gate={gate}
                resolving={resolving}
                onApprove={(reason) => void transition('approved', reason)}
                onReject={(reason) => void transition('rejected', reason)}
              />
            ) : (
              <div className="space-y-3">
                <GateEvidence gate={gate} />
                {gateNeedsAction(gate) ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="min-h-12 flex-1 gap-1.5"
                      disabled={resolving}
                      onClick={() => void transition('rejected')}
                    >
                      <XCircle className="size-4" />
                      {t('gateReject')}
                    </Button>
                    <Button
                      className="min-h-12 flex-1 gap-1.5"
                      disabled={resolving}
                      onClick={() => void transition('approved')}
                    >
                      <CheckCircle className="size-4" />
                      {resolving ? '...' : t('gateApprove')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {gateDecision(gate) === 'block' ? t('gateReadonlyBlock') : t('gateReadonlyAuto')}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
