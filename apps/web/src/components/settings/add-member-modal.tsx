'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { Button } from '@/components/ui/button';
import { AddAgentForm } from './add-agent-form';
import { cn } from '@/lib/utils';

type MemberType = 'human' | 'agent';

interface AddMemberModalProps {
  open: boolean;
  onClose: () => void;
  orgId: string;
  projects: { id: string; name: string }[];
  defaultType?: MemberType;
  /** 에이전트 옵션 노출 여부. 에이전트 관리 IA 통일(story d63d3f73) 후 settings Members는
   * People 전용이라 false로 꺼서 human-only 폼 하나만 보인다(에이전트 추가는 `/agents` 관리 탭). */
  allowAgentType?: boolean;
  /** 제출 성공 시 호출 — 부모가 해당 subtab 갱신 + 토스트. */
  onAdded: (type: MemberType, message: string) => void;
}

/**
 * 7363ec8a — 멤버/에이전트 추가 단일 진입(점진: "+멤버 추가" 모달). type 토글로 사람/에이전트
 * 조건부 폼. 기존 BE 계약 무변경(사람=POST invites / 에이전트=POST team-members)·기존 폼 재사용.
 */
export function AddMemberModal({ open, onClose, orgId, projects, defaultType = 'human', allowAgentType = true, onAdded }: AddMemberModalProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [type, setType] = useState<MemberType>(defaultType);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 사람(invite)
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  // 에이전트(v2)는 <AddAgentForm>가 자체 state/submit/결과 phase 호스팅 — 모달은 human invite만 다룬다.

  const reset = () => {
    setType(defaultType);
    setEmail(''); setRole('member'); setProjectIds([]);
    setError(null);
  };
  const close = () => { reset(); onClose(); };

  // CP4: 모달은 열릴 때마다 fresh state로 — type을 현 defaultType(활성 subtab)에 동기화 +
  // 폼/error 초기화. close→reopen 시 직전 선택(예: 에이전트) persist 방지.
  useEffect(() => {
    if (!open) return;
    setType(defaultType);
    setEmail(''); setRole('member'); setProjectIds([]);
    setError(null);
  }, [open, defaultType]);
  const toggleProject = (id: string) =>
    setProjectIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // human invite 전용(agent는 AddAgentForm가 처리). orgId null 가드 — /organizations/null/invites 차단.
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
      onAdded('human', t('addMemberInviteSuccess'));
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

        {/* type 토글 — 사람/에이전트 segmented(radiogroup·roving tabindex·aria-checked·←→ 화살표 이동) */}
        {allowAgentType && (
        <div
          role="radiogroup"
          aria-label={t('addMemberType')}
          className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1"
          onKeyDown={(e) => {
            // a11y: 화살표로 라디오 옵션 이동(WAI-ARIA radiogroup).
            if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
              e.preventDefault();
              const next: MemberType = type === 'human' ? 'agent' : 'human';
              setType(next);
              setError(null);
              const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
              (next === 'human' ? btns[0] : btns[1])?.focus();
            }
          }}
        >
          {(['human', 'agent'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={type === opt}
              tabIndex={type === opt ? 0 : -1}
              onClick={() => { setType(opt); setError(null); }}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                type === opt ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt === 'human' ? t('typeHuman') : t('typeAgent')}
            </button>
          ))}
        </div>
        )}

        {type === 'human' ? (
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
        ) : (
          <AddAgentForm
            projects={projects}
            onCreated={() => onAdded('agent', t('addMemberAgentSuccess'))}
            onDone={close}
          />
        )}

        {type === 'human' && error ? <p className="text-xs text-destructive">{error}</p> : null}

        {type === 'human' ? (
          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={submitting}>{tc('cancel')}</Button>
            <Button variant="hero" onClick={() => void submitHuman()} disabled={submitting || !orgId}>
              {submitting ? '...' : t('addMember')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
