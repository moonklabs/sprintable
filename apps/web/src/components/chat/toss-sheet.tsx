'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageSquare, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/db/client';

interface TossParticipant {
  member_id: string;
  name: string | null;
}

interface TossConversation {
  id: string;
  type: 'dm' | 'group';
  title: string | null;
  participants?: TossParticipant[];
}

// story #3084(2026-08-25, 유나 픽셀 규격 §2) — chat-list-view.tsx의 formatParticipantNames와
// 동형(DM은 상대 1인, group은 최대 3인+나머지 카운트) — 별도 모듈로 뽑지 않고 이 파일 소비
// 범위만 최소 재구현한다(chat-list-view.tsx도 이미 호출부 2곳에 동형 로직을 각자 갖는
// 관례 — 이 파일이 그 세 번째 자리라 해도 기존 컨벤션과 어긋나지 않는다).
function conversationDisplayName(conv: TossConversation, currentTeamMemberId: string): string {
  if (conv.title) return conv.title;
  const others = (conv.participants ?? []).filter((p) => p.member_id !== currentTeamMemberId);
  if (others.length === 0) return conv.type === 'dm' ? 'DM' : conv.id.slice(0, 8);
  return others.map((p) => p.name ?? '?').join(', ');
}

export interface TossSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateId: string;
  projectId: string;
  currentTeamMemberId: string;
  designatedApproverId: string;
  designatedApproverName: string | null;
  /** 200 성공 — inserted=신규 삽입 여부(story #3094, GateTossResponse.inserted). false=멱등
   * no-op(대상에 이미 카드 사본이 있었음). 호출부가 문구 분기+게이트 재조회를 담당. */
  onTossed: (targetConversationTitle: string, inserted: boolean) => void;
  /** 409(gate_already_resolved) — 시트를 닫고 "이미 처리된 결재" 안내(유나 규격 §2). */
  onAlreadyResolved: () => void;
}

/**
 * story #3084(2026-08-25, 유나 픽셀 규격 v1 §2) — 결재 카드 토스 시트. 대상 conversation
 * 피커=designated 본인이 참여한 대화만(BE 422 target_approver_not_participant 사전 방지,
 * #3001 "카드=지정 라인 전용" 정책의 FE 절반). `GET /api/conversations?project_id=`는
 * **caller가 참여한** 대화만 돌려주므로(BE list_conversations 계약), 여기서 다시 designated
 * 참여 여부로 좁히면 "나도 있고 designated도 있는 방"만 후보로 남는다 — 토스를 실행하는
 * 사람(requester/designated 본인) 스스로 그 방에 없으면 애초에 픽커에 골라 넣을 수 없는
 * 게 맞는 제약(비참여 방으로 몰래 보내는 경로 자체가 없다).
 *
 * story #3094(2026-08-26, 유나 규격 c40bf168 §2 SSOT) — 위 "알려진 축소" 후속. BE에
 * "이 gate_id 카드가 이미 있는 conversation 전체 목록"을 물을 데이터 소스는 여전히 없다
 * (신규 리스팅 엔드포인트는 이번 스코프 밖) — 대신 이 세션에서 실제로 토스를 시도한
 * 대상만 결과(inserted)로 학습해 "이미 있음" 칩을 붙인다. 시트를 닫았다 다시 열어도(재토스
 * 진입) 같은 TossSheet 인스턴스가 유지되는 한 칩이 남아 — 방금 토스했던 대상을 실수로
 * 다시 골라도(멱등 자체는 무해) 사전에 "이미 있음"이 보인다.
 */
export function TossSheet({
  open, onOpenChange, gateId, projectId, currentTeamMemberId, designatedApproverId, designatedApproverName,
  onTossed, onAlreadyResolved,
}: TossSheetProps) {
  const t = useTranslations('chats');
  const [conversations, setConversations] = useState<TossConversation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyThereIds, setAlreadyThereIds] = useState<Set<string>>(new Set());
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedId(null);
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    void fetchWithAuth(`/api/conversations?project_id=${projectId}&limit=100`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: TossConversation[] } | null) => {
        setConversations(json?.data ?? []);
      })
      .catch(() => setConversations([]))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  const candidates = useMemo(() => {
    const list = (conversations ?? []).filter((c) =>
      (c.participants ?? []).some((p) => p.member_id === designatedApproverId)
    );
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => conversationDisplayName(c, currentTeamMemberId).toLowerCase().includes(q));
  }, [conversations, designatedApproverId, query, currentTeamMemberId]);

  const submit = async () => {
    if (!selectedId) return;
    const target = candidates.find((c) => c.id === selectedId);
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${gateId}/toss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_conversation_id: selectedId }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null) as { inserted?: boolean } | null;
        const inserted = body?.inserted ?? true;
        setAlreadyThereIds((prev) => new Set(prev).add(selectedId));
        onOpenChange(false);
        onTossed(target ? conversationDisplayName(target, currentTeamMemberId) : '', inserted);
        return;
      }
      const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
      if (res.status === 409) {
        onOpenChange(false);
        onAlreadyResolved();
        return;
      }
      setError(body?.error?.message ?? `HTTP ${res.status}`);
    } catch {
      setError(t('hitlSendFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const approverLabel = designatedApproverName ?? designatedApproverId.slice(0, 8);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-w-md">
        <SheetHeader>
          <SheetTitle>{t('approvalRequestTossSheetTitle')}</SheetTitle>
          <SheetDescription>{t('approvalRequestTossSheetDescription', { name: approverLabel })}</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('approvalRequestTossSearchPlaceholder')}
          />
        </div>
        <div className="max-h-72 overflow-y-auto px-2 pb-2">
          {error ? <p role="alert" aria-live="assertive" className="px-2 pb-2 text-[11px] text-foreground">{error}</p> : null}
          {loading ? (
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          ) : candidates.length === 0 ? (
            <EmptyState
              title={t('approvalRequestTossEmptyTitle')}
              description={t('approvalRequestTossEmptyBody', { name: approverLabel })}
            />
          ) : (
            candidates.map((c) => {
              const name = conversationDisplayName(c, currentTeamMemberId);
              const selected = selectedId === c.id;
              // story #3094(유나 규격 §2 .pick.done) — 이 세션에서 이미 토스 시도한 대상.
              const alreadyThere = alreadyThereIds.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  aria-pressed={selected}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted',
                    selected && 'bg-muted',
                    alreadyThere && 'opacity-70'
                  )}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    {c.type === 'dm' ? <MessageSquare className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
                  {alreadyThere ? (
                    // 유나 규격 정정(design gate 반려, 2026-08-26) — text-primary는 bg-primary/10
                    // 위에서 opacity-70(부모 row)과 겹치면 라이트 2.83/다크 3.04로 AA 미달
                    // (hover 시 더 낮음). text-foreground는 같은 조건에서 5.4~6.9 PASS.
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-semibold text-foreground">
                      {t('approvalRequestTossAlreadyThereChip')}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'size-4 shrink-0 rounded-full border-2',
                        selected ? 'border-primary bg-primary' : 'border-border'
                      )}
                      aria-hidden
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
        <SheetFooter className="flex-row">
          <Button type="button" variant="ghost" className="flex-1" onClick={() => onOpenChange(false)}>
            {t('approvalRequestTossCancel')}
          </Button>
          <Button type="button" className="flex-1" disabled={!selectedId || submitting} onClick={() => void submit()}>
            {t('approvalRequestTossSend')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
