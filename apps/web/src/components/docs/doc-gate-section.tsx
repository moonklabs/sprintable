'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldCheck, ShieldX, RotateCcw, Pencil, History, User, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { GateItem } from '@/components/kanban/types';

/**
 * E-DG S28 — doc decision gate UI(doc 상세 상단). S24 hypothesis-gate-badge 어휘 미러·신규 토큰 0.
 * 배지 3상태 = doc.status(draft 제외 pending/confirmed/denied). 반려 사유 = doc gate(work_item_type='doc').
 * ⭐재상신 CTA "재검토 요청" = draft→pending(gate 재진입·새 검토 사이클). draft→confirmed 아님
 *   (저자 자기승인 금지·confirmed/denied는 resolver 액션 결과·BE가 caller 강제). 승인 게이트 무결성.
 * revision 타임라인 = GET /docs/{id}/revisions(org-scoped IDOR fix). superseded_by는 cross-doc(여기 미사용).
 */
type DocGateState = 'pending' | 'confirmed' | 'denied';

const META: Record<DocGateState, { variant: 'warning' | 'success' | 'destructive'; Icon: typeof Shield; labelKey: string }> = {
  pending: { variant: 'warning', Icon: Shield, labelKey: 'docGatePending' },
  confirmed: { variant: 'success', Icon: ShieldCheck, labelKey: 'docGateConfirmed' },
  denied: { variant: 'destructive', Icon: ShieldX, labelKey: 'docGateDenied' },
};

interface DocRevision {
  id: string;
  created_by?: string | null;
  created_at?: string;
}

function toState(status: string | undefined): DocGateState | null {
  if (status === 'pending' || status === 'confirmed' || status === 'denied') return status;
  return null; // draft 등은 배지 미표시
}

export function DocGateSection({
  docId,
  status,
  onTransitioned,
}: {
  docId: string;
  status: string | undefined;
  onTransitioned: () => void;
}) {
  const t = useTranslations('docs');
  const [gate, setGate] = useState<GateItem | null>(null);
  const [revisions, setRevisions] = useState<DocRevision[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [revOpen, setRevOpen] = useState(false); // 기본 접힘(본문 우선·이력 secondary — 개수가 레이아웃 못 밀어냄)

  const load = useCallback(async () => {
    const [gates, revsJson, membersJson] = await Promise.all([
      fetch(`/api/gates?work_item_id=${docId}&work_item_type=doc`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`/api/docs/${docId}/revisions`).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
      fetch('/api/team-members').then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
    ]);
    const gs = (Array.isArray(gates) ? gates : []) as GateItem[];
    // 반려/검토중 gate 우선(사유·진행 상태)·없으면 최신.
    setGate(gs.find((g) => g.status === 'rejected' || g.status === 'denied' || g.status === 'pending') ?? gs[0] ?? null);
    const rv = ((revsJson?.data ?? revsJson) as DocRevision[]) || [];
    setRevisions(Array.isArray(rv) ? [...rv].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')) : []);
    const names: Record<string, string> = {};
    for (const m of ((membersJson?.data ?? []) as { id: string; name: string }[])) names[m.id] = m.name;
    setMemberNames(names);
  }, [docId]);

  useEffect(() => { void load(); }, [load]);

  const state = toState(status);
  const meta = state ? META[state] : null;
  const MetaIcon = meta?.Icon;
  const resolveName = (id: string | null | undefined) => (id ? (memberNames[id] ?? id.slice(0, 6)) : '—');
  const fmtDate = (s: string | undefined) => (s ? new Date(s).toLocaleString() : '');

  const transition = async (next: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/docs/${docId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) { onTransitioned(); await load(); }
    } finally { setBusy(false); }
  };

  // 상태도 이력(gate/revision)도 없으면 미표시(노이즈 0·boy-scout). 이력 있는 draft = 재상신 컨텍스트.
  const hasHistory = gate != null || revisions.length > 0;
  if (!state && !hasHistory) return null;

  return (
    <section aria-label={t('docGateLabel')} className="mb-4 max-h-[40vh] space-y-2 overflow-y-auto rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {meta && MetaIcon ? (
          <Badge variant={meta.variant} className="shrink-0 gap-1">
            <MetaIcon className="size-3 shrink-0" />
            {t(meta.labelKey)}
          </Badge>
        ) : null}
        {/* ⭐재검토 요청(draft→pending·재상신) — 이력 있는 draft만. 저자 자기승인 아님(검토 재진입). */}
        {status === 'draft' && hasHistory ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1 text-primary hover:bg-primary/10 hover:text-primary"
            disabled={busy}
            onClick={() => void transition('pending')}
          >
            <RotateCcw className="size-3.5" />
            {t('docGateResubmit')}
          </Button>
        ) : null}
      </div>

      {/* 반려 섹션: 사유 + 결재자 + 시각 + 수정 진입(denied→draft) */}
      {state === 'denied' ? (
        <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
          <p className="text-xs font-medium text-destructive">{t('docGateDeniedReason')}</p>
          <p className="whitespace-pre-wrap text-xs text-foreground">{gate?.resolution_note?.trim() || t('docGateNoReason')}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><User className="size-3" />{resolveName(gate?.resolver_id)}</span>
            {gate?.resolved_at ? <span>· {fmtDate(gate.resolved_at)}</span> : null}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-foreground hover:bg-accent"
            disabled={busy}
            onClick={() => void transition('draft')}
          >
            <Pencil className="size-3.5" />
            {t('docGateEdit')}
          </Button>
        </div>
      ) : null}

      {/* revision 타임라인(v1→vN·created_at 오름차). 접기-기본 + 바운드 scroll → 이력 개수가 본문 못 밀어냄. */}
      {revisions.length > 0 ? (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setRevOpen((o) => !o)}
            aria-expanded={revOpen}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <History className="size-3 shrink-0" />
            {t('docGateRevisions')}
            <span className="text-muted-foreground/70">({revisions.length})</span>
            <ChevronDown className={`size-3 shrink-0 transition-transform ${revOpen ? 'rotate-180' : ''}`} />
          </button>
          {revOpen ? (
            <ul className="max-h-32 space-y-0.5 overflow-y-auto pr-1">
              {revisions.map((rev, i) => (
                <li key={rev.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="shrink-0 font-mono text-foreground">v{i + 1}</span>
                  <span className="shrink-0">{resolveName(rev.created_by)}</span>
                  <span className="min-w-0 truncate">{fmtDate(rev.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
