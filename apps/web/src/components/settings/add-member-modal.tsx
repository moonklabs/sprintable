'use client';

import { useState, useEffect, useId } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ds/dialog';
import { Input } from '@/components/ds/input';
import { NativeSelect } from '@/components/ds/select';
import { cn } from '@/lib/utils';
import { useRenderNonce } from '@/hooks/use-render-nonce';

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
  // story #2154 — orgId/email 빈값 사전검증이 setError(null) 리셋보다 먼저 return해,
  // 연속 동일 실패 시 재낭독이 안 될 수 있던 것을 nonce-key로 구조적으로 막는다.
  const [errorNonce, bumpErrorNonce] = useRenderNonce();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const titleId = useId();

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
    if (!orgId) { bumpErrorNonce(); setError(t('addMemberInviteError')); return; }
    if (!email.trim()) { bumpErrorNonce(); setError(t('inviteEmailRequired')); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role, project_ids: projectIds }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; limit?: number } };
      if (!res.ok) {
        bumpErrorNonce();
        // story #2485 — EE plan_limits.check_member_invite_limit()가 실제로 이 code를
        // 낸다(그라운딩 확認, org-members-section.tsx와 동일 엔드포인트). 그 외 code는
        // backend가 generic HTTP상태만 준다 — raw 서버 message 노출 대신 고정 문구.
        if (json.error?.code === 'PLAN_LIMIT_EXCEEDED') {
          setError(t('memberLimitExceededError', { limit: json.error.limit ?? 1 }));
        } else {
          setError(t('addMemberInviteError'));
        }
        return;
      }
      onAdded(t('addMemberInviteSuccess'));
      close();
    } catch {
      bumpErrorNonce();
      setError(t('addMemberInviteError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId}>{t('addMember')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('inviteEmailPlaceholder')}
            aria-label={t('inviteEmailPlaceholder')}
          />
          <NativeSelect value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')} aria-label={t('agentRoleLabel')}>
            <option value="member">{t('roleMember')}</option>
            <option value="admin">{t('roleAdmin')}</option>
          </NativeSelect>
          <div className="space-y-1.5">
            <p className="text-ds-small font-semibold text-ds-ink">{t('inviteProjectsLabel')}</p>
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  variant="secondary"
                  aria-pressed={projectIds.includes(p.id)}
                  onClick={() => toggleProject(p.id)}
                  className={cn(projectIds.includes(p.id) && 'border-ds-action bg-ds-action-soft text-ds-action-text')}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {error ? <Banner key={errorNonce} tone="failed">{error}</Banner> : null}

        <DialogFooter>
          <Button variant="quiet" onClick={close} disabled={submitting}>{tc('cancel')}</Button>
          <Button variant="primary" onClick={() => void submitHuman()} disabled={submitting || !orgId}>
            {submitting ? '...' : t('addMember')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
