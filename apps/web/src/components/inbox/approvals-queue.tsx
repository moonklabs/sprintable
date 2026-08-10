'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle } from 'lucide-react';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import { gateNeedsAction } from '@/components/cage/gate-evidence';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { cn } from '@/lib/utils';
import type { GateInboxItem, GateItem, HitlInboxItem } from '@/components/kanban/types';

// story #1960(P2-S4) — 결재함 통합 큐. Gate 3종(게이트·문서결재·머지게이트, gate_type/
// work_item_type discriminator로 단일 Gate 테이블에 자연 수렴 — #1954에서 확定된 스코프
// 그대로 재사용) 단일 목록. decision(inbox_items)은 별도 표면(/inbox 기본 탭 DecisionsWaiting
// 유지) — 이 큐엔 편입하지 않는다(PO+디디+유나 확定).
//
// 정렬(긴급도) — `?sort=urgency`(story #1973, 배포 완료)가 SLA overdue 최상위→age(created_at)
// 오래된 순 정렬을 내려준다. `status` 필터는 여전히 하드 필터라(list_gates가 `Gate.status==
// status`로 배타 조회) pending/held는 별도 쿼리가 필요 — pending 목록 뒤에 held 목록을 그대로
// 이어붙이면 "held 최하단" 요건이 만족된다(각 목록 내부 정렬은 BE가 이미 보장, 클라 재정렬 불요).
//
// 개인화(담당자 스코프) — story #1974(디디+미르코, high, 선생님 실사용 지적으로 등재).
// `assigned_to_me=true`(디디 BE 계약 shape 확定, 2026-07-17)로 "내가 승인 가능한 것만"
// 스코프. BE 배포 전엔 FastAPI가 미인식 쿼리파라미터를 무시하므로 안전한 no-op(기존과
// 동일 org-wide) — 배포되면 자동 개인화. fetchGates()를 단일 함수로 캡슐화해 이 지점만
// 교체하면 되도록 설계했다 — 컴포넌트 나머지는 무영향.
//
// story #2054(P0): Gate/HitlRequest 두 체계가 같은 승인 병목(merge)에서 서로를 못 보던 결함
// 해소 — `/api/gates`(Gate 단독)에서 `/api/gates/inbox`(Gate+HitlRequest 통합, `source`로
// 판별)로 교체한다. 데이터모델은 안 합치고(디디 BE·오르테가 판정) 이 read-layer만 통합했다.
// HitlRequest 항목은 상세 페이지가 없어(간단한 park 요청이라 `/gates/[id]`급 화면이 불필요)
// 이 큐 안에서 바로 승인/반려하는 인라인 액션으로 둔다 — Gate 항목은 기존대로 클릭 시
// `/gates/{id}` 상세로 이동.
async function fetchGates(): Promise<GateInboxItem[]> {
  const [pending, held] = await Promise.all([
    fetch('/api/gates/inbox?status=pending&sort=urgency&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
    fetch('/api/gates/inbox?status=held&sort=urgency&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
  ]);
  return [...(pending as GateInboxItem[]), ...(held as GateInboxItem[])];
}

function isHitl(item: GateInboxItem): item is HitlInboxItem {
  return item.source === 'hitl';
}

function isHeld(gate: GateItem): boolean {
  return gate.status === 'held' || !!gate.held_until;
}

// story #1961(P2-S5) — gates/[id]/page.tsx의 canAct 판정과 동일 규칙(중복 빌드 봉쇄 취지상
// 판정 로직을 새로 짓지 않고 그대로 재사용 — gateNeedsAction만 import, doc/canonicalize
// 특례·can_approve 게이팅까지 canonical 상세와 1:1).
function isDocGate(gate: GateItem): boolean {
  return gate.work_item_type === 'doc' || gate.gate_type === 'doc_approval';
}
function isCanonicalizeGate(gate: GateItem): boolean {
  return gate.gate_type === 'artifact_canonicalize';
}
function needsAction(gate: GateItem): boolean {
  return gate.status === 'pending' && (gateNeedsAction(gate) || isDocGate(gate) || isCanonicalizeGate(gate));
}
// story #1961 AC — "고위험 항목 인라인 승인 버튼 0". risk==='low' 확정일 때만 이 큐 안에서
// 바로 승인/반려한다(gate-risk.ts usesSignatureFlow와 동일 경계 — high·unknown은 원탭 대상
// 아님, 클릭하면 canonical 상세의 서명 플로우로 간다).
function canInlineResolve(gate: GateItem): boolean {
  return needsAction(gate) && gate.can_approve === true && !usesSignatureFlow(deriveRiskLevel(gate));
}

// AC §3.1 "노화 표시" — BE 신규 필드 불요, 기존 created_at으로 직접 계산(오르테가군 판정).
function formatAge(createdAt: string, t: ReturnType<typeof useTranslations>): string {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  if (days <= 0) return t('queueAgeToday');
  return t('queueAgeDays', { days });
}

export function ApprovalsQueue() {
  const t = useTranslations('cage');
  const router = useRouter();
  // story #2103 — BE `PATCH /api/v1/hitl-requests/{id}`가 human-only 불변식이다(gates.py
  // transition_gate_endpoint와 동형, resolved.type != "human" → 403). #2091(게이트 상세)과
  // 같은 버그클래스: 이 큐는 그 판정을 미리 안 보고 에이전트 계정에도 승인/반려 버튼을
  // 무조건 열었다. Gate와 달리 HitlInboxItem엔 per-item can_approve 필드가 없어(BE 응답
  // shape 차이) 계정 자체의 type(human/agent, DashboardContext #2103 신규)으로 게이팅한다.
  const { orgMemberships, currentMemberType } = useDashboardContext();
  const canResolveHitl = currentMemberType === 'human';
  const [items, setItems] = useState<GateInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  // story #1961(P2-S5) — 저위험 gate를 인라인으로 승인/반려한 결과. 목록에서 즉시 지우지
  // 않고(hitl과 다른 결정) "완료 상태 + 기록 링크"로 그 자리에서 바로 바꾼다 — AC "승인 후
  // 완료 상태+서명 기록 링크 즉시"가 재조회나 페이지 전환 없이 서야 하기 때문. resolving===id
  // 동안 버튼이 비활성화되고, 성공하면 이 맵에 값이 생겨 버튼 자체가 사라지므로(아래 렌더
  // 분기) 중복 탭이 두 번째 요청을 만들 수 없다(요청 자체가 안 나감).
  const [resolvedGates, setResolvedGates] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [gateErrors, setGateErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void fetchGates().then((rows) => {
      if (!cancelled) {
        setItems(rows);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // story #2054 AC3: HitlRequest는 상세 페이지가 없어 이 큐 안에서 바로 승인/반려한다 —
  // 승인 후 원래 작업(report-done)이 통과하는지는 사용자 왕복(재시도)으로 확認된다.
  const resolveHitl = async (id: string, status: 'approved' | 'rejected') => {
    setResolving(id);
    try {
      const res = await fetch(`/api/v1/hitl-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) setItems((prev) => prev.filter((it) => it.id !== id));
    } finally {
      setResolving(null);
    }
  };

  // story #1961(P2-S5) — 저위험 gate 원탭 승인/반려. gates/[id]/page.tsx의 저위험 분기(근거·
  // 사유 없는 단순 transition)와 동일 엔드포인트·body — 서명 플로우(usesSignatureFlow)는
  // canInlineResolve가 이미 걸러 이 함수에 안 들어온다.
  const resolveGate = async (id: string, status: 'approved' | 'rejected') => {
    setResolving(id);
    setGateErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const res = await fetch(`/api/gates/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note: null }),
      });
      if (res.ok) {
        setResolvedGates((prev) => ({ ...prev, [id]: status }));
      } else {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setGateErrors((prev) => ({ ...prev, [id]: body?.error?.message ?? `HTTP ${res.status}` }));
      }
    } finally {
      setResolving(null);
    }
  };

  if (loading) return <p className="text-xs text-muted-foreground">{t('gateInboxLoading')}</p>;

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-5 text-center">
        <p className="text-sm text-muted-foreground">{t('gateInboxEmpty')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => {
        if (isHitl(item)) {
          return (
            <div key={item.id} className="flex flex-col gap-1.5 rounded-xl border border-info/30 bg-info/5 px-4 py-3">
              <div className="flex w-full flex-wrap items-center gap-1.5">
                <Badge variant="chip">{t('hitlRequestBadge')}</Badge>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatAge(item.created_at, t)}</span>
              </div>
              <p className="text-sm text-foreground">{item.title}</p>
              <p className="line-clamp-2 text-[11px] text-muted-foreground">{item.prompt}</p>
              {canResolveHitl ? (
                <div className="mt-1 flex justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-muted-foreground hover:text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60"
                    disabled={resolving === item.id}
                    onClick={() => void resolveHitl(item.id, 'rejected')}
                  >
                    <XCircle className="size-3.5" />
                    {t('gateReject')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-success hover:bg-success-tint hover:text-success"
                    disabled={resolving === item.id}
                    onClick={() => void resolveHitl(item.id, 'approved')}
                  >
                    <CheckCircle className="size-3.5" />
                    {t('gateApprove')}
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-right text-[11px] text-muted-foreground">{t('gateReadonlyNotAuthorized')}</p>
              )}
            </div>
          );
        }

        const gate = item;
        const held = isHeld(gate);
        const orgName = orgMemberships.find((o) => o.orgId === gate.org_id)?.orgName;
        const resolved = resolvedGates[gate.id];
        const inlineResolvable = !resolved && canInlineResolve(gate);
        const gateBody = (
          <>
            <div className="flex w-full flex-wrap items-center gap-1.5">
              <Badge variant="chip">{gate.gate_type}</Badge>
              {held ? (
                <Badge variant="secondary">{t('heldBadge')}</Badge>
              ) : deriveRiskLevel(gate) === 'high' ? (
                <Badge variant="warning">{t('riskHigh')}</Badge>
              ) : deriveRiskLevel(gate) === 'unknown' ? (
                <Badge variant="outline" className="text-muted-foreground">{t('riskUnknown')}</Badge>
              ) : null}
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatAge(gate.created_at, t)}</span>
            </div>
            <p className="truncate text-sm text-foreground">
              {gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`}
            </p>
            {orgName ? <p className="text-[11px] text-muted-foreground">{orgName}</p> : null}
          </>
        );

        // story #1961(P2-S5) — 저위험이면서 아직 인라인으로 안 끝난 항목만 이 2단 구조(제목=
        // 상세 이동 버튼 + 그 아래 승인/반려 행)로 렌더한다. 그 외(고위험·unknown·held·이미
        // 인라인 처리됨)는 기존 그대로 «행 전체가 상세로 가는 단일 버튼»— 고위험 항목엔
        // 인라인 승인 버튼이 «아예 안 생긴다»(AC, 새 분기 자체를 안 탐).
        if (!inlineResolvable) {
          if (resolved) {
            return (
              <div key={gate.id} className="rounded-xl border border-border bg-card px-4 py-3">
                <button
                  type="button"
                  onClick={() => router.push(`/gates/${gate.id}`)}
                  className="flex w-full flex-col items-start gap-1 text-left"
                >
                  {gateBody}
                </button>
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
                  <span className={cn('flex items-center gap-1 text-xs font-medium', resolved === 'approved' ? 'text-success' : 'text-muted-foreground')}>
                    {resolved === 'approved' ? <CheckCircle className="size-3.5" /> : <XCircle className="size-3.5" />}
                    {t(resolved === 'approved' ? 'queueResolvedApproved' : 'queueResolvedRejected')}
                  </span>
                  <Link href={`/gates/${gate.id}`} className="text-xs font-medium text-primary hover:underline">
                    {t('queueViewRecord')}
                  </Link>
                </div>
              </div>
            );
          }
          return (
            <button
              key={gate.id}
              type="button"
              onClick={() => router.push(`/gates/${gate.id}`)}
              className="flex min-h-12 w-full flex-col items-start gap-1 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40"
            >
              {gateBody}
            </button>
          );
        }

        return (
          <div key={gate.id} className="rounded-xl border border-border bg-card px-4 py-3">
            <button
              type="button"
              onClick={() => router.push(`/gates/${gate.id}`)}
              className="flex w-full flex-col items-start gap-1 text-left"
            >
              {gateBody}
            </button>
            {gateErrors[gate.id] ? (
              <p
                className="mt-2 rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-foreground"
                role="alert"
                aria-live="assertive"
              >
                {t('gateTransitionError', { reason: gateErrors[gate.id] })}
              </p>
            ) : null}
            <div className="mt-2 flex justify-end gap-1.5 border-t border-border pt-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1 text-muted-foreground hover:text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60"
                disabled={resolving === gate.id}
                onClick={() => void resolveGate(gate.id, 'rejected')}
              >
                <XCircle className="size-3.5" />
                {t('gateReject')}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1"
                disabled={resolving === gate.id}
                onClick={() => void resolveGate(gate.id, 'approved')}
              >
                <CheckCircle className="size-3.5" />
                {resolving === gate.id ? '...' : t('gateApprove')}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
