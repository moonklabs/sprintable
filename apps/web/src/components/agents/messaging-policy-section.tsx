'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Plus, TriangleAlert, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { useToast } from '@/components/ui/toast';

type MessagingMode = 'creator_only' | 'org_wide' | 'list';
const MODES: MessagingMode[] = ['creator_only', 'list', 'org_wide'];

interface OrgHuman {
  id: string;
  user_id: string | null;
  name: string;
}

interface MessagingPolicySectionProps {
  agentId: string;
  /** 에이전트 생성자 user_id — list 모드 최상단 "항상 허용" 행 식별용 */
  creatorUserId: string | null;
}

export function MessagingPolicySection({ agentId, creatorUserId }: MessagingPolicySectionProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<MessagingMode>('creator_only');
  const [stagedMode, setStagedMode] = useState<MessagingMode>('creator_only');
  const [savingMode, setSavingMode] = useState(false);

  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [orgHumans, setOrgHumans] = useState<OrgHuman[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const load = useCallback(async () => {
    const [policyRes, membersRes] = await Promise.all([
      fetch(`/api/agents/${agentId}/message-policy`).catch(() => null),
      fetch('/api/org-members').catch(() => null),
    ]);
    if (policyRes?.ok) {
      const json = await policyRes.json() as { data?: { mode?: MessagingMode; allowlist?: string[] } };
      const m = json.data?.mode ?? 'creator_only';
      setMode(m);
      setStagedMode(m);
      setAllowlist(json.data?.allowlist ?? []);
    }
    if (membersRes?.ok) {
      const json = await membersRes.json() as { data?: Array<{ id: string; user_id: string | null; name: string }> };
      setOrgHumans((json.data ?? []).map((m) => ({ id: m.id, user_id: m.user_id, name: m.name })));
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const nameOf = useCallback(
    (memberId: string) => orgHumans.find((m) => m.id === memberId)?.name ?? `${t('messagingUnknownMember')} (${memberId.slice(0, 8)})`,
    [orgHumans, t],
  );

  const creatorMemberId = useMemo(
    () => (creatorUserId ? orgHumans.find((m) => m.user_id === creatorUserId)?.id ?? null : null),
    [orgHumans, creatorUserId],
  );

  // picker 후보: org 휴먼 중 이미 allowlist에 있거나 creator인 멤버 제외
  const pickerCandidates = useMemo(
    () => orgHumans.filter((m) => !allowlist.includes(m.id) && m.id !== creatorMemberId),
    [orgHumans, allowlist, creatorMemberId],
  );

  const handleSaveMode = async () => {
    if (stagedMode === mode || savingMode) return;
    setSavingMode(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/message-policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: stagedMode }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? t('messagingPolicySaveError') });
        return;
      }
      setMode(stagedMode);
      addToast({ type: 'success', title: t('messagingPolicySaved') });
    } finally {
      setSavingMode(false);
    }
  };

  const handleAddMember = async (memberId: string) => {
    setPendingId(memberId);
    try {
      const res = await fetch(`/api/agents/${agentId}/message-policy/allowlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: memberId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
        return;
      }
      const json = await res.json() as { data?: { allowlist?: string[] } };
      setAllowlist(json.data?.allowlist ?? [...allowlist, memberId]);
      setShowPicker(false);
    } finally {
      setPendingId(null);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    setPendingId(memberId);
    try {
      const res = await fetch(`/api/agents/${agentId}/message-policy/allowlist/${memberId}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
        return;
      }
      const json = await res.json() as { data?: { allowlist?: string[] } };
      setAllowlist(json.data?.allowlist ?? allowlist.filter((id) => id !== memberId));
    } finally {
      setPendingId(null);
    }
  };

  // 방향키 roving — radiogroup 표준 키보드 내비게이션
  const handleRadioKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % MODES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + MODES.length) % MODES.length;
    if (next === null) return;
    e.preventDefault();
    setStagedMode(MODES[next]);
    radioRefs.current[next]?.focus();
  };

  if (loading) return null;

  const modeLabel: Record<MessagingMode, { label: string; hint: string }> = {
    creator_only: { label: t('messagingModeCreatorOnly'), hint: t('messagingModeCreatorOnlyHint') },
    list: { label: t('messagingModeList'), hint: t('messagingModeListHint') },
    org_wide: { label: t('messagingModeOrgWide'), hint: t('messagingModeOrgWideHint') },
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('messagingPolicyTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('messagingPolicyHelper')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {/* 모드 선택 (radio-card) */}
        <div role="radiogroup" aria-label={t('messagingPolicyTitle')} className="grid gap-2 sm:grid-cols-3">
          {MODES.map((m, i) => {
            const selected = stagedMode === m;
            return (
              <button
                key={m}
                ref={(el) => { radioRefs.current[i] = el; }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setStagedMode(m)}
                onKeyDown={(e) => handleRadioKeyDown(e, i)}
                className={`flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/50'
                }`}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{modeLabel[m].label}</span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-brand" />}
                </div>
                <span className="text-xs text-muted-foreground">{modeLabel[m].hint}</span>
              </button>
            );
          })}
        </div>

        {/* mode = staged + Save */}
        {stagedMode !== mode && (
          <div className="flex justify-end">
            <Button variant="hero" size="sm" onClick={() => void handleSaveMode()} disabled={savingMode}>
              {savingMode ? '...' : tc('save')}
            </Button>
          </div>
        )}

        {/* org_wide 경고 */}
        {stagedMode === 'org_wide' && (
          <Alert variant="warning" className="grid grid-cols-[auto_1fr] gap-x-3">
            <TriangleAlert className="h-4 w-4 translate-y-0.5" aria-hidden />
            <div>
              <AlertTitle>{t('messagingOrgWideWarningTitle')}</AlertTitle>
              <AlertDescription>{t('messagingOrgWideWarningDesc')}</AlertDescription>
            </div>
          </Alert>
        )}

        {/* list 모드: allowlist (creator 잠금 + 멤버 행 + picker) */}
        {stagedMode === 'list' && (
          <div className="space-y-2">
            {/* creator 고정·제거불가 행 */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              <span className="truncate text-foreground">
                {creatorMemberId ? nameOf(creatorMemberId) : t('messagingCreatorSelf')}
              </span>
              <Badge variant="secondary" className="shrink-0">{t('messagingCreatorBadge')}</Badge>
            </div>

            {/* allowlist 멤버 행 (creator 제외) */}
            {allowlist.filter((id) => id !== creatorMemberId).map((id) => (
              <div key={id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <span className="truncate text-foreground">{nameOf(id)}</span>
                <button
                  type="button"
                  onClick={() => void handleRemoveMember(id)}
                  disabled={pendingId === id}
                  className="shrink-0 text-muted-foreground transition hover:text-destructive disabled:opacity-50"
                  aria-label={tc('delete')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}

            {allowlist.filter((id) => id !== creatorMemberId).length === 0 && (
              <p className="px-1 py-2 text-xs text-muted-foreground">{t('messagingAllowlistEmpty')}</p>
            )}

            {/* 멤버 추가 picker */}
            {showPicker ? (
              <div className="rounded-md border border-border">
                {pickerCandidates.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">{t('messagingNoCandidates')}</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto p-1">
                    {pickerCandidates.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => void handleAddMember(m.id)}
                          disabled={pendingId === m.id}
                          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted disabled:opacity-50"
                        >
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                            {m.name?.slice(0, 2)?.toUpperCase() ?? '?'}
                          </div>
                          <span className="flex-1 truncate">{m.name}</span>
                          {pendingId === m.id && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setShowPicker(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t('messagingAddMember')}
              </Button>
            )}
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
