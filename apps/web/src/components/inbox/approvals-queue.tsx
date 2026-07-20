'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle } from 'lucide-react';
import { deriveRiskLevel } from '@/components/cage/gate-risk';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
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

// AC §3.1 "노화 표시" — BE 신규 필드 불요, 기존 created_at으로 직접 계산(오르테가군 판정).
function formatAge(createdAt: string, t: ReturnType<typeof useTranslations>): string {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  if (days <= 0) return t('queueAgeToday');
  return t('queueAgeDays', { days });
}

export function ApprovalsQueue() {
  const t = useTranslations('cage');
  const router = useRouter();
  const { orgMemberships } = useDashboardContext();
  const [items, setItems] = useState<GateInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);

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
              <div className="mt-1 flex justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
            </div>
          );
        }

        const gate = item;
        const held = isHeld(gate);
        const orgName = orgMemberships.find((o) => o.orgId === gate.org_id)?.orgName;
        return (
          <button
            key={gate.id}
            type="button"
            onClick={() => router.push(`/gates/${gate.id}`)}
            className="flex min-h-12 w-full flex-col items-start gap-1 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40"
          >
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
          </button>
        );
      })}
    </div>
  );
}
