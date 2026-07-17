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
import type { GateItem } from '@/components/kanban/types';

// story #1954(P1a-S4) — Gate 3종(게이트·문서결재·머지게이트) canonical 상세. P1a·P2 공용 유일
// per-gate 라우트(중복 빌드 봉쇄) — decision(inbox_items)은 별도 표면(오르테가군 PO 판단+
// 디디군·유나양 2줄검증 확定, 2026-07-17). #1951 매니페스트 target=gate_detail·parentTab=approvals.
//
// ⚠️BE 계약 갭(story #1970, 디디군 오너, 진행 중): `GET /api/v2/gates/{id}` 단건 조회 엔드포인트
// 자체가 아직 없다(list_gates 필터만 존재) + GateResponse에 project_id 필드 부재 + work_item_summary
// enrich가 doc 타입 한정. 이 페이지는 그 계약이 확定되는 즉시 소비하도록 GateDetail 타입을 그
// shape 초안 그대로 맞춰뒀다 — 라우트/컴포넌트 골격은 지금 완성, 데이터 바인딩만 계약 확定 후 마무리.
//
// ⚠️위험도(risk) 필드도 BE에 아직 없다(gate.py에 risk_level 류 없음) — "저·고위험=동일 BE 위험도
// 필드"(AC) 요구를 만족하려면 이것도 #1970 계약 논의에 포함돼야 한다. 그때까지 riskLevel은 항상
// 'unknown'으로 렌더되며(추측 배지 금지), 실 필드가 오면 deriveRiskLevel 한 곳만 교체하면 된다.
interface GateDetail extends GateItem {
  org_id: string;
  project_id?: string | null; // #1970 신규 예정 필드
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
                {t('gateDetailOrgContext', { org: gate.org_id.slice(0, 8) })}
                {gate.project_id ? ` · ${gate.project_id.slice(0, 8)}` : ''}
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
