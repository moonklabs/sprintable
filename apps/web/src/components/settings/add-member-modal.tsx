'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AddMemberModalProps {
  open: boolean;
  onClose: () => void;
  orgId: string;
  projects: { id: string; name: string }[];
  /** 제출 성공 시 호출 — 부모가 목록 갱신 + 토스트. */
  onAdded: (message: string) => void;
}

/**
 * 7363ec8a — "+멤버 추가" 모달(human invite). 에이전트 추가는 story d82c1092(생성경로 단일화)로
 * `/agents` 채용 탭으로 흡수됐다 — settings Members는 People 전용.
 */
export function AddMemberModal({ open, onClose, orgId, projects, onAdded }: AddMemberModalProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [projectIds, setProjectIds] = useState<string[]>([]);

  const reset = () => {
    setEmail(''); setRole('member'); setProjectIds([]);
    setError(null);
  };
  const close = () => { reset(); onClose(); };

  // CP4: 모달은 열릴 때마다 fresh state로 초기화.
  useEffect(() => {
    if (!open) return;
    setEmail(''); setRole('member'); setProjectIds([]);
    setError(null);
  }, [open]);
  const toggleProject = (id: string) =>
    setProjectIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submitHuman = async () => {
    if (submitting) return;
    if (!orgId) { setError(t('addMemberInviteError')); return; }
    if (!email.trim()) { setError(t('inviteEmailRequired')); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role, project_ids: projectIds }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) { setError(json.error?.message ?? t('addMemberInviteError')); return; }
      onAdded(t('addMemberInviteSuccess'));
      close();
    } catch {
      setError(t('addMemberInviteError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('addMember')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <OperatorInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('inviteEmailPlaceholder')}
          />
          <OperatorDropdownSelect
            value={role}
            onValueChange={(v) => setRole(v as 'admin' | 'member')}
            options={[
              { value: 'member', label: t('roleMember') },
              { value: 'admin', label: t('roleAdmin') },
            ]}
          />
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t('inviteProjectsLabel')}</p>
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={projectIds.includes(p.id)}
                  onClick={() => toggleProject(p.id)}
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs transition-colors',
                    projectIds.includes(p.id)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted/40',
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={submitting}>{tc('cancel')}</Button>
          <Button variant="hero" onClick={() => void submitHuman()} disabled={submitting || !orgId}>
            {submitting ? '...' : t('addMember')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
