'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { deriveRiskLevel } from '@/components/cage/gate-risk';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';

// story #1960(P2-S4) — 결재함 통합 큐. Gate 3종(게이트·문서결재·머지게이트, gate_type/
// work_item_type discriminator로 단일 Gate 테이블에 자연 수렴 — #1954에서 확定된 스코프
// 그대로 재사용) 단일 목록. decision(inbox_items)은 별도 표면(/inbox 기본 탭 DecisionsWaiting
// 유지) — 이 큐엔 편입하지 않는다(PO+디디+유나 확定).
//
// ⚠️정렬(긴급도) BE 계약 갭 — `list_gates`에 정렬 로직이 없다(ORDER BY 없음, DB 삽입순).
// 오르테가군 판정(2026-07-17): BE가 `?sort=urgency`로 SLA overdue>age>held 하단 순 정렬을
// 내려주는 계약이 확定됐으나 아직 미구현(디디군 배정 예정, story 등재 대기). 그때까지 이
// 컴포넌트가 클라이언트에서 held 하단+created_at 오름차순(오래 대기한 것 우선)으로 임시
// 정렬한다 — `?sort=urgency`가 배포되면 이 클라이언트 정렬 로직만 제거하면 된다(BE 응답
// 순서를 그대로 신뢰).
//
// 개인화(담당자 스코프) — story #1974(디디+미르코, high, 선생님 실사용 지적으로 등재).
// `assigned_to_me=true`(디디 BE 계약 shape 확定, 2026-07-17)로 "내가 승인 가능한 것만"
// 스코프. BE 배포 전엔 FastAPI가 미인식 쿼리파라미터를 무시하므로 안전한 no-op(기존과
// 동일 org-wide) — 배포되면 자동 개인화. fetchGates()를 단일 함수로 캡슐화해 이 지점만
// 교체하면 되도록 설계했다 — 컴포넌트 나머지는 무영향.
async function fetchGates(): Promise<GateItem[]> {
  const [pending, held] = await Promise.all([
    fetch('/api/gates?status=pending&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
    fetch('/api/gates?status=held&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
  ]);
  return [...(pending as GateItem[]), ...(held as GateItem[])];
}

function isHeld(gate: GateItem): boolean {
  return gate.status === 'held' || !!gate.held_until;
}

// TODO(BE ?sort=urgency 배포 후 제거): held 하단 + created_at 오름차순(오래 대기 우선) 임시 정렬.
function sortByInterimUrgency(gates: GateItem[]): GateItem[] {
  return [...gates].sort((a, b) => {
    const aHeld = isHeld(a) ? 1 : 0;
    const bHeld = isHeld(b) ? 1 : 0;
    if (aHeld !== bHeld) return aHeld - bHeld;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
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
  const [gates, setGates] = useState<GateItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetchGates().then((rows) => {
      if (!cancelled) {
        setGates(sortByInterimUrgency(rows));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <p className="text-xs text-muted-foreground">{t('gateInboxLoading')}</p>;

  if (gates.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-5 text-center">
        <p className="text-sm text-muted-foreground">{t('gateInboxEmpty')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {gates.map((gate) => {
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
