'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { toPlainPreview } from '@/components/chat/entity-ref';

export interface ChatV3ThreadParticipant {
  member_id: string;
  name: string | null;
  type?: string;
}

export interface ChatV3Thread {
  id: string;
  participants: ChatV3ThreadParticipant[];
  latest_message: { content: string | null; created_at: string | null } | null;
  unread_count: number;
  // story #4314 — 대화의 프로젝트(목록 · 단건 응답 둘 다 싣는다 · ConversationResponse.project_id). 문맥 패널 작업 항목 링크의 대상 프로젝트.
  project_id?: string | null;
}

/**
 * story #3972 — 스레드 레일. 그라운딩(#3971) 확認대로 `GET /api/conversations`
 * 응답엔 팀 role(예: "PO") 필드가 없어(participants[].type만 있음, human|agent)
 * 시안의 「PO」 태그를 정확히 못 낸다 — 페드루 PO 판정(부재 8-①) "role_template
 * 조합"도 이 스코프에선 추가 콜 없인 안 돼, 그라운딩된 값만 정직하게 쓴다:
 * type==='agent' → 「에이전트」 태그. human은 태그 없음(지어내지 않음, no-fiction).
 */
function otherParticipant(participants: ChatV3ThreadParticipant[], meId: string): ChatV3ThreadParticipant | undefined {
  return participants.find((p) => p.member_id !== meId) ?? participants[0];
}

export function ChatV3ThreadRail({ threads, meId, selectedId, onSelect }: {
  threads: ChatV3Thread[];
  meId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('chatV3');

  return (
    <section className="flex w-full shrink-0 flex-col border-r border-border bg-card lg:w-[320px]" data-testid="chat-v3-thread-rail">
      <div className="flex h-[52px] shrink-0 items-center border-b border-border px-4">
        <h1 className="text-[15px] font-bold text-foreground">{t('threadRailTitle')}</h1>
      </div>
      {threads.length === 0 ? (
        <p className="p-5 text-center text-sm text-muted-foreground">{t('threadRailEmpty')}</p>
      ) : (
        <ul className="focus-inset flex-1 overflow-auto">
          {threads.map((thread, index) => {
            const other = otherParticipant(thread.participants, meId);
            const isAgent = other?.type === 'agent';
            const isSelected = thread.id === selectedId;
            const rowLabel = other?.name ?? t('unknownParticipant');
            const roleId = isAgent ? `chat-v3-thread-${thread.id}-role` : null;
            const previewId = `chat-v3-thread-${thread.id}-preview`;
            return (
              <li key={thread.id}>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onSelect(thread.id)}
                  data-testid="chat-v3-thread-row"
                  aria-current={isSelected}
                  aria-label={t('threadRowAriaLabel', { n: index + 1, label: rowLabel })}
                  aria-describedby={[roleId, previewId].filter(Boolean).join(' ')}
                  className={
                    isSelected
                      ? 'h-auto min-h-0 w-full items-start justify-start gap-2.5 rounded-none border-b border-border bg-primary/10 px-4 py-3 text-left font-normal whitespace-normal hover:bg-primary/10 focus-visible:ring-inset active:translate-y-0'
                      : 'h-auto min-h-0 w-full items-start justify-start gap-2.5 rounded-none border-b border-border px-4 py-3 text-left font-normal whitespace-normal hover:bg-muted/50 focus-visible:ring-inset active:translate-y-0'
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold text-foreground">{rowLabel}</span>
                      {/* 교차 PR 드리프트(유나 점검표 1c6a0ced, 항목 4) — 색 있는
                          attention(위험·질문·사람 손 필요)만 Badge, 중립 역할
                          라벨은 muted-text span(4373 task 상태 라벨과 같은 결).
                          story #3972 CI 후속(페드루 PO) — 버튼에 aria-label을
                          붙이면 스크린리더가 자식 텍스트를 더 안 읽어(대체가
                          아니라 은폐) 이 역할 표시·미리보기가 사라졌다 —
                          aria-describedby로 다시 잇는다. */}
                      {isAgent ? <span id={roleId ?? undefined} className="shrink-0 text-[10px] text-muted-foreground" data-testid="chat-v3-role-tag-agent">{t('roleTagAgent')}</span> : null}
                    </div>
                    <p id={previewId} className="mt-0.5 truncate text-xs text-muted-foreground">{toPlainPreview(thread.latest_message?.content ?? '')}</p>
                  </div>
                  {thread.unread_count > 0 ? (
                    <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" data-testid="chat-v3-unread-dot" />
                  ) : null}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
