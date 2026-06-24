'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserCog, ArrowRightLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { GateApproverItem } from '@/components/kanban/types';

/**
 * E-DG S32 — parallel gate 결재자 재지정 모달(admin). 현 pending 결재자 → 새 결재자 picker
 * (add-participant 패턴·/api/members·현 approver 제외) + 사유 선택. POST /api/gates/{id}/reassign
 * → 갱신된 approver 목록(onResolved refetch). reassigner=BE 강제·gate status 불변. 신규 토큰 0.
 */
interface Member { id: string; name: string }

export function GateReassignModal({
  gateId,
  approvers,
  projectId,
  resolveName,
  onClose,
  onResolved,
}: {
  gateId: string;
  approvers: GateApproverItem[];
  projectId: string;
  resolveName: (id: string) => string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const t = useTranslations('cage');
  const pending = approvers.filter((a) => a.status === 'pending');
  const [oldApproverId, setOldApproverId] = useState<string>(pending.length === 1 ? pending[0]!.approver_member_id : '');
  const [newApproverId, setNewApproverId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const currentIds = approvers.map((a) => a.approver_member_id);

  useEffect(() => {
    fetch(`/api/members?is_active=true&project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => setMembers((j.data ?? []) as Member[]))
      .catch(() => setMembers([]));
  }, [projectId]);

  const available = members.filter((m) => !currentIds.includes(m.id));
  const canSubmit = !!newApproverId && (pending.length <= 1 || !!oldApproverId) && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body: { new_approver_id: string; old_approver_id?: string; reason?: string } = { new_approver_id: newApproverId };
      if (oldApproverId) body.old_approver_id = oldApproverId;
      if (reason.trim()) body.reason = reason.trim();
      const res = await fetch(`/api/gates/${gateId}/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) { onResolved(); onClose(); }
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-label={t('cancel')} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <UserCog className="size-4 shrink-0 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('reassignTitle')}</h3>
        </div>

        {pending.length > 1 ? (
          <label className="mb-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {t('reassignOldLabel')}
            <select value={oldApproverId} onChange={(e) => setOldApproverId(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {pending.map((a) => <option key={a.id} value={a.approver_member_id}>{resolveName(a.approver_member_id)}</option>)}
            </select>
          </label>
        ) : pending.length === 1 ? (
          <p className="mb-2 text-xs text-muted-foreground">{t('reassignCurrent')}: <span className="text-foreground">{resolveName(pending[0]!.approver_member_id)}</span></p>
        ) : null}

        <label className="mb-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {t('reassignNewLabel')}
          <select value={newApproverId} onChange={(e) => setNewApproverId(e.target.value)} className={inputCls}>
            <option value="">{t('reassignNewPlaceholder')}</option>
            {available.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>

        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('reassignReasonPlaceholder')}
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-primary hover:bg-primary/10 hover:text-primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            <ArrowRightLeft className="size-3.5" />
            {submitting ? '...' : t('reassignConfirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
