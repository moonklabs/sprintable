'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AgentIdentity } from '@/components/ui/agent-identity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { buildPolicyDeniedMessage, parseAgentMessagePolicyDenied } from '@/lib/agent-message-policy-error';
import { fetchWithAuth } from '@/lib/db/client';

interface Member {
  id: string;
  name: string;
  type: string;
  // story #3194 — /api/members(정본 SSOT)엔 없는 필드라 별도 /api/team-members?type=agent
  // 조회로 채운다(#2751 get_verified_map 그대로 재사용, 발명 0). human/미조회는 undefined.
  verified?: boolean | null;
}

// story #2613 — 정책 거부(AGENT_MESSAGE_POLICY_DENIED)는 대상 에이전트로의 워크포스 설정
// 딥링크가 필요해 단순 문자열보다 구조가 더 필요하다(그 외 실패는 기존처럼 문자열 그대로).
type ModalError = { kind: 'generic'; message: string } | { kind: 'policy'; message: string; agentId: string };

interface NewConversationModalProps {
  projectId: string;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}

export function NewConversationModal({ projectId, onClose, onCreated }: NewConversationModalProps) {
  const t = useTranslations('chats');
  // story #3194 — agentNotConnected 배지 문구 재사용(발명 0, agent-management-tab.tsx와 동일 키).
  const ta = useTranslations('agents');
  const [members, setMembers] = useState<Member[]>([]);
  // story #3194 — 별도 state로 둔다(members setter와 순서 경쟁 없이 항상 render에서만 merge).
  const [verifiedById, setVerifiedById] = useState<Record<string, boolean | null>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ModalError | null>(null);

  useEffect(() => {
    fetchWithAuth(`/api/members?is_active=true&project_id=${projectId}`)
      .then((r) => r.json())
      .then((json) => setMembers((json.data ?? []) as Member[]))
      .catch(() => {})
      .finally(() => setLoading(false));
    // story #3194 — 연결 상태(발명 0, #2751 get_verified_map)는 /api/members가 안 실어주는
    // 필드라 team-members 쪽에서 따로 받는다. 별개 state로 둬 위 members fetch와의 완료
    // 순서에 안 낚인다(render에서만 merge, 실패해도 배지만 안 뜰 뿐 graceful).
    fetchWithAuth('/api/team-members?type=agent')
      .then((r) => r.json())
      .then((json) => {
        const vMap: Record<string, boolean | null> = {};
        for (const m of (json.data ?? []) as Array<{ id: string; verified?: boolean | null }>) {
          vMap[m.id] = m.verified ?? null;
        }
        setVerifiedById(vMap);
      })
      .catch(() => {});
  }, [projectId]);

  const toggle = (id: string) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const isDm = selected.length === 1;
  const canCreate = selected.length >= 1;

  const handleCreate = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: isDm ? 'dm' : 'group',
          title: !isDm && groupTitle.trim() ? groupTitle.trim() : null,
          participant_ids: selected,
          project_id: projectId,
        }),
      });
      if (!res.ok) {
        // story #2613(PR #2824 승계) — creator/allowlist 정책 거부는 generic 403이 아니라
        // 구조화 코드로 온다(BE PR#3096). 서버 message는 로케일 무관 영문 고정문이라 그대로
        // 노출하지 않고(계약 원칙), reason을 보고 FE가 actionable 안내를 직접 구성한다.
        const body = await res.json().catch(() => null);
        const policy = parseAgentMessagePolicyDenied(body);
        if (policy) {
          setError({ kind: 'policy', message: buildPolicyDeniedMessage(policy, members, t), agentId: policy.agent_id });
          return;
        }
        throw new Error('Failed to create conversation');
      }
      const data = await res.json() as { id: string };
      onCreated(data.id);
    } catch {
      setError({ kind: 'generic', message: '대화 생성에 실패했습니다. 다시 시도해보세요.' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !creating) onClose(); }}>
      <DialogContent className="max-w-md overflow-hidden rounded-xl p-0" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-semibold text-foreground">{t('newConversation')}</DialogTitle>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="mb-2 text-xs text-muted-foreground">{t('selectMembers')}</p>
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">불러오는 중…</div>
          ) : (
            <ul className="space-y-1">
              {members.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                      selected.includes(m.id)
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                      {m.name?.slice(0, 2)?.toUpperCase() ?? '?'}
                    </div>
                    <span className="flex-1 truncate">{m.name}</span>
                    {/* story #3049(2984-S1) — AgentIdentity 프리미티브(헤어라인+proof-blue
                        신호 dot) 채택, soft-fill 폐지. */}
                    {m.type === 'agent' && <AgentIdentity />}
                    {/* story #3194(AC3) — 새 대화 상대 선택기에도 연결 상태 노출(발명 0, #2751
                        get_verified_map 그대로 — agent-management-tab.tsx와 동일 배지). */}
                    {m.type === 'agent' && verifiedById[m.id] === false ? (
                      <Badge variant="warning" className="shrink-0">{ta('agentNotConnected')}</Badge>
                    ) : null}
                    {selected.includes(m.id) && <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Group title (2명+ 선택 시) */}
          {selected.length >= 2 && (
            <div className="mt-3">
              <label className="mb-1 block text-xs text-muted-foreground">{t('groupTitle')}</label>
              <input
                type="text"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                placeholder={t('groupTitlePlaceholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {/* story #2105 2차 — handleCreate가 재시도 전 setError(null)을 먼저 호출해(위 정의) 매
              시도마다 언마운트→리마운트된다. */}
          {error && (
            <p role="alert" aria-live="assertive" aria-atomic="true" className="mt-2 text-xs text-destructive">
              {error.message}
              {error.kind === 'policy' ? (
                <>
                  {' · '}
                  <Link href={`/organization/workforce/${error.agentId}`} className="text-primary underline">
                    {t('policyDeniedManageLink')}
                  </Link>
                </>
              ) : null}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={creating}>
            취소
          </Button>
          <Button size="sm" onClick={() => void handleCreate()} disabled={!canCreate || creating}>
            {creating ? '생성 중…' : t('create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
