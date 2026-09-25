'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AgentIdentity } from '@/components/ui/agent-identity';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { buildPolicyDeniedMessage, parseAgentMessagePolicyDenied } from '@/lib/agent-message-policy-error';
import { memberDisplayLabel } from '@/lib/member-display';
import { UnnamedMemberIcon } from '@/components/shared/unnamed-member-icon';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { useFlatHref } from '@/hooks/use-flat-href';

interface Member {
  id: string;
  name: string;
  type: string;
  // story #3997(3994 후속) — /api/v2/members가 additive로 실어 보내기 시작한 필드
  // (MemberResponse.runtime_type). 「시스템 발행」을 이 select에서 걸러내는 데 쓴다.
  runtime_type?: string | null;
}

// story #2613 — new-conversation-modal.tsx와 동일 축(정책 거부는 딥링크가 필요한 구조).
type ModalError = { kind: 'generic'; message: string } | { kind: 'policy'; message: string; agentId: string };

interface AddParticipantModalProps {
  conversationId: string;
  conversationType: 'dm' | 'group';
  projectId: string;
  existingParticipantIds: string[];
  onClose: () => void;
  onAdded: (newConversationId?: string) => void;
}

export function AddParticipantModal({
  conversationId,
  conversationType,
  projectId,
  existingParticipantIds,
  onClose,
  onAdded,
}: AddParticipantModalProps) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('chats');
  const tc = useTranslations('common');
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ModalError | null>(null);

  useEffect(() => {
    fetchWithAuth(`/api/members?is_active=true&project_id=${projectId}`)
      .then((r) => r.json())
      .then((json) => {
        // story #3997 — 「시스템 발행」을 이 대화에 참가자로 추가하는 것 자체가
        // 의미 없다(연결 대상이 아닌 내부 멤버) — 선택지에서 제외.
        const list = (json.data ?? []) as Member[];
        setMembers(list.filter((m) => !isSystemPublisher(m.runtime_type)));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  const available = members.filter((m) => !existingParticipantIds.includes(m.id));

  const handleAdd = async () => {
    if (!selected || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: selected }),
      });
      if (!res.ok) {
        // story #2613(PR #2824 승계) — new-conversation-modal.tsx와 동일 계약/원칙.
        const body = await res.json().catch(() => null);
        const policy = parseAgentMessagePolicyDenied(body);
        if (policy) {
          setError({ kind: 'policy', message: buildPolicyDeniedMessage(policy, members, t), agentId: policy.agent_id });
          return;
        }
        throw new Error('Failed to add participant');
      }
      const data = await res.json() as { conversation_id?: string; forked?: boolean };
      onAdded(data.conversation_id);
    } catch {
      setError({ kind: 'generic', message: t('addParticipantFailed') });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !adding) onClose(); }}>
      <DialogContent className="max-w-md overflow-hidden rounded-xl p-0" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-semibold text-foreground">{t('addParticipantsTitle')}</DialogTitle>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {conversationType === 'dm' && (
            <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t('forkInfo')}
            </p>
          )}
          <p className="mb-2 text-xs text-muted-foreground">{t('selectMembers')}</p>
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{tc('loading')}</div>
          ) : available.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('noAvailableMembersToAdd')}</div>
          ) : (
            <ul className="space-y-1">
              {available.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelected((prev) => (prev === m.id ? null : m.id))}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                      selected === m.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                      {/* [SID:4286 · 유나 결정 2] 이름이 없으면 날것 «?» 대신 아이콘(에이전트 Bot · 사람 User — 4646 공용 표식). */}
                      {m.name ? m.name.slice(0, 2).toUpperCase() : <UnnamedMemberIcon type={m.type} className="h-3 w-3" aria-hidden />}
                    </div>
                    {/* [SID:4286 · 유나 규칙 06:48Z] 같은 행에 타입 표식(원 아이콘 · AgentIdentity)이 있어 라벨은 «이름 없는 구성원» 하나. */}
                    <span className="flex-1 truncate">{memberDisplayLabel(m.name, tc)}</span>
                    {/* story #3049(2984-S1) — AgentIdentity 프리미티브(헤어라인+proof-blue
                        신호 dot) 채택, soft-fill 폐지. */}
                    {m.type === 'agent' && <AgentIdentity />}
                    {selected === m.id && <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer — story #4193: 거부/실패 안내는 스크롤 목록 «밖», 버튼 줄과 선 하나짜리 푸터 영역 안(안내가 누른
            버튼 바로 위에 붙는다). 목록 안 맨 끝에 있으면 멤버가 많을 때 «대화 시작» 직후 보이는 영역 아래(라이브
            380~414px)에 묻혀 «눌렀는데 아무 일도 없음»이 됐다. 링크는 한 덩어리(nowrap), 본문은 낱말 단위(break-keep)로
            접힌다(유나 design, 390·360). */}
        <div className="border-t border-border">
          {/* story #2105 2차 — handleAdd이 재시도 전 setError(null)을 먼저 호출해(위 정의) 매
              시도마다 언마운트→리마운트된다. */}
          {error && (
            <p role="alert" aria-live="assertive" aria-atomic="true" className="break-keep px-4 pt-3 text-xs text-destructive">
              {error.message}
              {error.kind === 'policy' ? (
                <>
                  {' · '}
                  <Link href={flatHref(`/organization/workforce/${error.agentId}`)} className="whitespace-nowrap text-primary underline">
                    {t('policyDeniedManageLink')}
                  </Link>
                </>
              ) : null}
            </p>
          )}
          <div className="flex justify-end gap-2 px-4 py-3">
            <Button variant="outline" size="sm" onClick={onClose} disabled={adding}>
              {tc('cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleAdd()} disabled={!selected || adding}>
              {adding ? tc('adding') : t('addParticipants')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
