'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckCircle, XCircle } from 'lucide-react';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import { gateNeedsAction } from '@/components/cage/gate-evidence';
import { GateUndoButton, UNDO_WINDOW_MS } from '@/components/cage/gate-undo-button';
import { GateDiscussDialog } from '@/components/cage/gate-discuss-dialog';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateInboxItem, GateItem, HitlInboxItem } from '@/components/kanban/types';

import { fetchWithAuth } from '@/lib/db/client';

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
    fetchWithAuth('/api/gates/inbox?status=pending&sort=urgency&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
    fetchWithAuth('/api/gates/inbox?status=held&sort=urgency&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
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
// story 22affaf2(PO 결정, 2026-08-16) — 구 #1961 AC "고위험 항목 인라인 승인 버튼 0"을
// 뒤집는다: 「함에서 승인/거절 못 함」의 실체가 고위험 인라인 부재였다(저위험은 이미
// #1961/#2631로 인라인 완비). 이제 위험도와 무관하게 인라인 처리 가능 — 고위험은
// GateSignatureApproval을 큐 안에서 Dialog로 열어 서명 플로우(근거열람+사유 없인 승인
// 비활성)를 그대로 거친다(서명 생략이 아니다, 아래 렌더 분기 참조). usesSignatureFlow는
// 이제 "인라인 가능 여부"가 아니라 "그 인라인이 원탭인지 서명모달인지"만 가른다.
function canInlineResolve(gate: GateItem): boolean {
  return needsAction(gate) && gate.can_approve === true && !isHeld(gate);
}

// AC §3.1 "노화 표시" — BE 신규 필드 불요, 기존 created_at으로 직접 계산(오르테가군 판정).
function formatAge(createdAt: string, t: ReturnType<typeof useTranslations>): string {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  if (days <= 0) return t('queueAgeToday');
  return t('queueAgeDays', { days });
}

// story 22affaf2(유나 design⑤) — undo 어포던스에 "N분 내 취소 가능" 미세 힌트를 곁들인다
// (안전망 인지 자체가 오발 방지의 일부 — 버튼만 덜렁 있는 것보다 "아직 취소 가능한 창"임을
// 명시). 5분 경과분은 null(호출부가 이미 UNDO_WINDOW_MS로 버튼 자체를 안 그린다 — 힌트도
// 버튼과 같은 조건으로 사라진다).
function formatUndoRemaining(resolvedAtMs: number, t: ReturnType<typeof useTranslations>): string | null {
  const remainingMs = UNDO_WINDOW_MS - (Date.now() - resolvedAtMs);
  if (remainingMs <= 0) return null;
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return t('gateUndoRemaining', { minutes });
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
  // PO 리뷰(PR#2948, 2026-08-12) — 단일 string|null이면 게이트 A in-flight 중 B를 클릭 후
  // A가 먼저 끝나면 finally의 setResolving(null)이 "전역" 값을 지워 B도 아직 in-flight인데
  // B 버튼이 재활성화된다(AC3 "중복 실행 0"이 다중 게이트 동시조작에서 깨지는 창). id별로
  // 독립적으로 추적해야 한 게이트의 완료가 다른 게이트의 disabled 상태를 건드리지 않는다.
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  // story #1961(P2-S5) — 저위험 gate를 인라인으로 승인/반려한 결과. 목록에서 즉시 지우지
  // 않고(hitl과 다른 결정) "완료 상태 + 기록 링크"로 그 자리에서 바로 바꾼다 — AC "승인 후
  // 완료 상태+서명 기록 링크 즉시"가 재조회나 페이지 전환 없이 서야 하기 때문. resolvingIds에
  // id가 있는 동안 버튼이 비활성화되고, 성공하면 이 맵에 값이 생겨 버튼 자체가 사라지므로(아래
  // 렌더 분기) 중복 탭이 두 번째 요청을 만들 수 없다(요청 자체가 안 나감).
  const [resolvedGates, setResolvedGates] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [gateErrors, setGateErrors] = useState<Record<string, string>>({});
  // story #2631 — 오클릭 정정 5분 창. items[]의 gate 객체는 resolveGate() 성공 후에도
  // 갱신되지 않는 스냅샷(status=pending 그대로) — resolver_id/resolved_at을 못 믿으므로
  // isUndoEligible(gate,...)을 못 쓴다. 대신 "이 세션에서 내가 방금 해소했다"는 사실 자체가
  // 곧 "본인+지금"이므로, 해소 성공 시각만 로컬로 잰다(서버 재조회 0 — AC 비용 절감).
  const [resolvedAtMs, setResolvedAtMs] = useState<Record<string, number>>({});
  // story #2631 — 「보류(논의 필요)」 다이얼로그. 목록이라 한 번에 하나만 연다(대상 id 하나로 충분).
  const [discussTargetId, setDiscussTargetId] = useState<string | null>(null);
  const [discussSubmitting, setDiscussSubmitting] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  // story 22affaf2 — 고위험 인라인 서명 모달. 목록이라 한 번에 하나만 연다(대상 id 하나로
  // 충분, discussTargetId와 동형). resolving/error는 resolvingIds/gateErrors를 그대로
  // 공유한다(별도 병렬 state를 새로 만들지 않는다 — 이 컴포넌트 전체가 이미 id 키로
  // 추적하는 관례를 그대로 따른다).
  const [signatureTargetId, setSignatureTargetId] = useState<string | null>(null);
  const signatureGate = signatureTargetId
    ? (items.find((it) => !isHitl(it) && it.id === signatureTargetId) as GateItem | undefined)
    : undefined;

  const discuss = async (id: string, reason: string) => {
    setDiscussSubmitting(true);
    setDiscussError(null);
    try {
      const res = await fetch(`/api/gates/${id}/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) { setDiscussTargetId(null); return; }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setDiscussError(body?.error?.message ?? t('gateTransitionErrorGeneric'));
    } catch {
      // story #2631 — PO 리뷰(PR#3068) 지적: try/finally뿐이면 네트워크 실패 시 무표시+
      // unhandled rejection. 챗 카드(approval-request-card.tsx)와 패리티.
      setDiscussError(t('gateTransitionErrorGeneric'));
    } finally {
      setDiscussSubmitting(false);
    }
  };

  // story #2631 — 오클릭 정정 성공 시 로컬 「해소됨」 상태를 지워 다시 액션 가능한(pending)
  // 카드로 되돌린다 — 목록 자체는 애초에 resolveGate()가 items에서 안 지웠으므로(hitl과
  // 다른 결정, 위 주석) 재조회 없이 그 자리서 되살릴 수 있다.
  const undoGate = (id: string) => {
    setResolvedGates((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setResolvedAtMs((prev) => { const next = { ...prev }; delete next[id]; return next; });
  };

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
    setResolvingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/v1/hitl-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) setItems((prev) => prev.filter((it) => it.id !== id));
    } finally {
      setResolvingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  // story #1961(P2-S5) — 저위험 gate 원탭 승인/반려, gates/[id]/page.tsx의 transition()과
  // 동일 엔드포인트·body. story 22affaf2 — 고위험 서명 플로우(GateSignatureApproval)도
  // 이제 이 함수를 그대로 쓴다(note=서명 사유) — 별도 함수를 새로 짓지 않는다(canonical
  // 상세의 transition()과 body shape을 1:1로 맞춘 이유이기도 함).
  const resolveGate = async (id: string, status: 'approved' | 'rejected', note: string | null = null) => {
    setResolvingIds((prev) => new Set(prev).add(id));
    setGateErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const res = await fetch(`/api/gates/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note: note?.trim() || null }),
      });
      if (res.ok) {
        setResolvedGates((prev) => ({ ...prev, [id]: status }));
        setResolvedAtMs((prev) => ({ ...prev, [id]: Date.now() }));
        // story 22affaf2 — 서명 모달을 거친 성공이면 그 자리서 닫는다(다른 gate의 모달을
        // 잘못 닫지 않도록 대상 id 일치 확認).
        setSignatureTargetId((cur) => (cur === id ? null : cur));
      } else {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setGateErrors((prev) => ({ ...prev, [id]: body?.error?.message ?? t('gateTransitionErrorGeneric') }));
      }
    } finally {
      setResolvingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
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
                    disabled={resolvingIds.has(item.id)}
                    onClick={() => void resolveHitl(item.id, 'rejected')}
                  >
                    <XCircle className="size-3.5" />
                    {t('gateReject')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    // story #2607 — workflow-line-editor-section.tsx의 동일 패턴(#2590 TIER3)과
                    // 같은 결함: rest는 투명 배경이라 text-success 그대로 통과하지만, hover만
                    // bg-success-tint(계열색 10~12% 알파)가 붙어 대비 미달. hover 글자만
                    // text-foreground로(#2420 규칙) — 그 fix를 놓친 자리였다.
                    className="h-7 gap-1 text-success hover:bg-success-tint hover:text-foreground"
                    disabled={resolvingIds.has(item.id)}
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
            {/* PO 실측(390px, 2026-08-16) — items-start 부모(flex-col)에서 truncate는 자기
                content 폭까지 shrink-to-fit돼 ellipsis가 걸릴 폭 기준 자체가 없다(카드
                우변에서 그냥 잘림). w-full로 폭을 부모 카드 전체로 고정해야 truncate가 실제로
                동작한다. */}
            <p className="w-full truncate text-sm text-foreground">
              {gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`}
            </p>
            {orgName ? <p className="text-[11px] text-muted-foreground">{orgName}</p> : null}
          </>
        );

        // story 22affaf2 — canInlineResolve(can_approve && needsAction && !held)를 만족하는
        // 항목만 이 2단 구조(제목=상세 이동 버튼 + 그 아래 승인/거절/보류 행)로 렌더한다 —
        // 이제 위험도와 무관(구 #1961 AC "고위험 인라인 0"은 이 스토리로 뒤집혔다, 위
        // canInlineResolve 주석 참조). 그 외(unknown 미배선·held·권한없음·이미 인라인
        // 처리됨)만 기존 그대로 «행 전체가 상세로 가는 단일 버튼».
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
                  {/* 유나 design:changes(2026-08-10) — 승인 텍스트 text-success on bg-card(흰)는
                      light AA 미달(text-xs). 의미는 아이콘 색으로 전하고, 글자는 항상
                      text-foreground(반려는 원래 muted-foreground로 AA 통과·그대로 유지). */}
                  <span className="flex items-center gap-1 text-xs font-medium">
                    {resolved === 'approved' ? (
                      <CheckCircle className="size-3.5 text-success" />
                    ) : (
                      <XCircle className="size-3.5 text-muted-foreground" />
                    )}
                    <span className={resolved === 'approved' ? 'text-foreground' : 'text-muted-foreground'}>
                      {t(resolved === 'approved' ? 'queueResolvedApproved' : 'queueResolvedRejected')}
                    </span>
                  </span>
                  <Link href={`/gates/${gate.id}`} className="text-xs font-medium text-primary hover:underline">
                    {t('queueViewRecord')}
                  </Link>
                </div>
                {/* story #2631 — 오클릭 정정(방금 본인이 이 세션에서 해소한 게이트, 5분 창).
                    story 22affaf2(유나 design⑤) — 남은 시간 힌트를 버튼 옆에 subtle하게
                    곁들인다(안전망 인지 자체가 오발 방지의 일부). */}
                {resolvedAtMs[gate.id] && Date.now() - resolvedAtMs[gate.id]! < UNDO_WINDOW_MS ? (
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <span className="text-[11px] text-muted-foreground">{formatUndoRemaining(resolvedAtMs[gate.id]!, t)}</span>
                    <GateUndoButton gateId={gate.id} onUndone={() => undoGate(gate.id)} />
                  </div>
                ) : null}
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

        // story 22affaf2(유나 design①③) — 저위험 원탭·고위험 서명모달 둘 다 이 하나의 카드
        // chrome을 쓴다(분기는 primary 라벨+onClick만 — 새 카드 컴포넌트를 만들지 않는다).
        // isSigFlow===true면 [승인하고 서명]/[변경 요청] 둘 다 서명 모달을 여는 것으로
        // 통일한다(canonical 상세와 동형 — GateSignatureApproval 화면 하나가 승인/거절
        // 둘 다 담당, canSign이 서명 생략을 막는다). 저위험은 기존처럼 즉시 transition.
        const isSigFlow = usesSignatureFlow(deriveRiskLevel(gate));
        const disabled = resolvingIds.has(gate.id);
        const primaryLabel = isSigFlow ? t('sigApproveAndSign') : t('gateApprove');
        const primaryOnClick = () => {
          if (isSigFlow) setSignatureTargetId(gate.id);
          else void resolveGate(gate.id, 'approved');
        };
        const rejectOnClick = () => {
          if (isSigFlow) setSignatureTargetId(gate.id);
          else void resolveGate(gate.id, 'rejected');
        };

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
            {/* story 22affaf2(유나 design①) — 모바일(≤390px) 2단 스택: 행1=primary 전폭,
                행2=변경요청+보류 각 flex-1. 데스크톱(≥sm)=단일 우측정렬 행, primary 최우측.
                order 유틸+wrapper의 sm:contents로 DOM은 한 세트만 유지한다(버튼 중복 렌더
                금지 — 테스트·접근성 트리 둘 다 단일 소스여야 함). */}
            <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2 sm:flex-row sm:items-center sm:justify-end">
              <div className="order-2 flex gap-1.5 sm:contents">
                <Button
                  size="sm"
                  variant="ghost"
                  className="order-1 h-8 flex-1 gap-1 text-muted-foreground hover:text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60 sm:order-1 sm:flex-none"
                  disabled={disabled}
                  onClick={rejectOnClick}
                >
                  <XCircle className="size-3.5" />
                  {t('sigRequestChanges')}
                </Button>
                {/* story #2631(PO 결정③) — 「보류(논의 필요)」는 결재함 전 게이트 타입 단일 표면. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="order-2 h-8 flex-1 text-muted-foreground sm:order-2 sm:flex-none"
                  disabled={disabled}
                  onClick={() => setDiscussTargetId(gate.id)}
                >
                  {t('gateDiscussSubmit')}
                </Button>
              </div>
              <Button
                size="sm"
                className="order-1 h-9 w-full gap-1.5 sm:order-3 sm:h-8 sm:w-auto"
                disabled={disabled}
                onClick={primaryOnClick}
              >
                <CheckCircle className="size-3.5" />
                {disabled && !isSigFlow ? '...' : primaryLabel}
              </Button>
            </div>
          </div>
        );
      })}
      <GateDiscussDialog
        open={discussTargetId !== null}
        onOpenChange={(open) => { if (!open) setDiscussTargetId(null); }}
        onSubmit={(reason) => { if (discussTargetId) void discuss(discussTargetId, reason); }}
        submitting={discussSubmitting}
        error={discussError}
      />
      {/* story 22affaf2(유나 design③) — 고위험 인라인 서명 모달. canonical 상세와 동일
          컴포넌트(GateSignatureApproval)를 nav 없이 Dialog로 연다 — 어휘·게이팅(canSign)
          둘 다 상세와 1:1이라 화면마다 다른 규칙을 새로 만들지 않는다. */}
      <Dialog
        open={signatureGate !== undefined}
        onOpenChange={(open) => {
          if (!open && !(signatureTargetId && resolvingIds.has(signatureTargetId))) setSignatureTargetId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {signatureGate ? (signatureGate.work_item_summary?.title ?? `#${signatureGate.work_item_id.slice(0, 8)}`) : ''}
            </DialogTitle>
          </DialogHeader>
          {signatureGate ? (
            <GateSignatureApproval
              gate={signatureGate}
              resolving={resolvingIds.has(signatureGate.id)}
              error={gateErrors[signatureGate.id]}
              onApprove={(reason) => void resolveGate(signatureGate.id, 'approved', reason)}
              onReject={(reason) => void resolveGate(signatureGate.id, 'rejected', reason)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
