'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
function conversationDisplayName(
  conv: TossConversation,
  currentTeamMemberId: string,
  t: (key: string) => string,
): string {
  if (conv.title) return conv.title;
  const others = (conv.participants ?? []).filter((p) => p.member_id !== currentTeamMemberId);
  // story #3203 — group 무참가자 폴백이 conv.id 앞 8자를 지어냈다(uuid 노출 표시결함,
  // chat-list-view.tsx의 formatParticipantNames와 동형 fix — unknownMember로 통일).
  // 참가자 이름 해석 실패(BE participant.name=null)도 '?' 대신 같은 문구.
  if (others.length === 0) return conv.type === 'dm' ? 'DM' : t('unknownMember');
  return others.map((p) => p.name ?? t('unknownMember')).join(', ');
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
  // story #3701(design CHANGES, 유나 — "완결 못 하면 완결인 척 안 한다") — 전량 로드가
  // 끝까지 못 간 3갈래(중간 페이지 !ok·MAX_PAGES 소진·total 부재라 완결 여부 판별 불가)를
  // 이 플래그 하나로 모은다. partial=true면 지금까지 모은 목록은 화면에 보여주되(누락된
  // 후보 있을 수 있음을 안내), candidates가 0건이어도 "대상 없음"으로 단정하지 않는다.
  const [partial, setPartial] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyThereIds, setAlreadyThereIds] = useState<Set<string>>(new Set());
  // story #3701(design CHANGES③, 페드루 — 카디르 QA 재현) — `fetchedRef`(한 번 불렀나)·
  // `cancelledRef`(취소됐나) 두 공유 불리언으로 "어느 요청이 현재인가"를 표현하면 둘 다
  // 완료 시점에만 리셋되는 래치라, 닫음(요청 pending)→재오픈(응답 미도착)→첫 응답 도착
  // 순서에서 재오픈이 fetchedRef===true로 조기 return(새 요청 없음)하고 뒤늦은 첫 응답도
  // cancelToken=true라 setLoading(false)를 못 불러 시트가 스켈레톤에 영구 고착됐다.
  // 요청마다 순번(reqSeqRef)을 매겨 "이 응답이 아직 최신 요청의 것인지"를 직접 판별하고,
  // 마지막으로 커밋(성공 반영)된 순번(loadedSeqRef)으로 "지금 순번까지 이미 반영됐는지"를
  // 판별한다 — 늦게 도착한 응답은 상태를 건드리지 않고 조용히 버려지고, 재오픈 시점에
  // 아직 반영 안 된 순번(진행 중이던 요청이 무효화됐거나 애초에 없었던 경우)이면 새로
  // 부른다. 재시도 도중 닫힘도 같은 축으로 커버된다(재시도가 커밋 못 한 채 닫히면
  // loadedSeqRef가 최신 순번을 못 따라가 재오픈 시 다시 부른다).
  const reqSeqRef = useRef(0);
  const loadedSeqRef = useRef(-1);

  const loadConversations = useCallback(() => {
    const mySeq = ++reqSeqRef.current;
    setLoading(true);
    setPartial(false);
    // story #3701 — `/api/conversations`는 has_more/next_cursor가 아니라 offset+total
    // 계약(#2231 세 번째 벌)이라, limit=100 한 페이지만 보고 끝내면 참여 대화가 101건을
    // 넘는 프로젝트에서 뒤쪽 대화가 후보 목록에서 침묵 절단됐다(토스 대상이 "없는 것"처럼
    // 보임 — #4049 비교뷰 has_more 무시와 동류). all.length가 total에 닿을 때까지
    // offset을 밀어 전량을 모은다. MAX_PAGES는 무한루프 안전판일 뿐(2000건은 실사용 밖).
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20;
    void (async () => {
      const all: TossConversation[] = [];
      let offset = 0;
      let sawPartial = false;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        let res: Awaited<ReturnType<typeof fetchWithAuth>>;
        try {
          res = await fetchWithAuth(`/api/conversations?project_id=${projectId}&limit=${PAGE_SIZE}&offset=${offset}`);
        } catch {
          sawPartial = true;
          break;
        }
        if (!res.ok) {
          sawPartial = true;
          break;
        }
        const json = await res.json().catch(() => null) as { data?: TossConversation[]; total?: number } | null;
        const pageData = json?.data ?? [];
        all.push(...pageData);
        offset += pageData.length;
        const total = json?.total;
        if (typeof total !== 'number') {
          // total이 없으면 "이게 전부"인지 알 도리가 없다 — 이 페이지까지만 신뢰하고 멈춘다.
          sawPartial = true;
          break;
        }
        if (pageData.length === 0) {
          // story #3701(카디르 QA, design CHANGES② 블로커①) — 빈 페이지가 곧 "완결"은
          // 아니다. total을 아직 못 채웠는데 서버가 빈 배열을 주면 그건 채우다 만
          // 불완전 상태(#4049 has_more 무시와 동류) — all.length>=total일 때만 진짜
          // 완결이고, 그 전에 빈 페이지가 오면 partial로 남긴다.
          if (all.length < total) sawPartial = true;
          break;
        }
        if (all.length >= total) break;
        if (page === MAX_PAGES - 1) sawPartial = true;
      }
      if (mySeq !== reqSeqRef.current) {
        // story #3701(design CHANGES③, 페드루) — 그새 시트가 닫혔거나(cleanup이 새 순번을
        // 만듦) 재시도 버튼이 새 요청을 냈다. 이 응답은 더 이상 최신이 아니니 상태를 건드리지
        // 않고 조용히 버린다 — 안 그러면 늦게 도착한 옛 응답이 최신 요청의 결과를 덮어쓴다.
        return;
      }
      setConversations(all);
      setPartial(sawPartial);
      setLoading(false);
      loadedSeqRef.current = mySeq;
    })();
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedId(null);
    // 현재 순번까지 이미 반영(커밋)됐으면 재요청 생략 — "이미 다 불러온 목록"까지 열 때마다
    // 다시 부르면 재시도 버튼의 존재 의미가 없어진다. 아직 반영 안 됐으면(첫 열림이거나,
    // 진행 중이던 요청이 지난 닫힘에서 무효화됐거나) 무조건 새로 부른다.
    //
    // story #3701(design CHANGES④, 페드루/카디르 재현, head 776cb4145) — 이 분기를 위의
    // "재요청 생략" 조건에 걸어 조기 return 해버리면(예전 코드) cleanup 등록 자체를
    // 건너뛴다. "이미 커밋된 데이터로 재오픈"한 렌더에서 재시도 버튼이 새 요청을 내고
    // 응답 前에 닫으면, 그 닫힘엔 실행할 cleanup이 없어(직전 렌더가 cleanup을 아예 안
    // 돌려줬으므로) reqSeqRef가 안 올라가고, 닫힌 동안 도착한 그 응답이 조용히 커밋된 뒤
    // 재오픈이 "이미 커밋됨"으로 오판해 재조회를 또 생략한다 — "닫힘=미커밋 요청 무효화"
    // 계약이 이 경로에서만 깨졌다. cleanup은 open인 한 매 렌더 항상 등록하고(무엇이 됐든
    // 그 시점 최신 순번 기준으로 판단), "요청을 낼지" 여부만 별도로 분기한다.
    if (loadedSeqRef.current !== reqSeqRef.current) loadConversations();
    return () => {
      if (loadedSeqRef.current !== reqSeqRef.current) {
        reqSeqRef.current += 1;
      }
    };
  }, [open, loadConversations]);

  const candidates = useMemo(() => {
    const list = (conversations ?? []).filter((c) =>
      (c.participants ?? []).some((p) => p.member_id === designatedApproverId)
    );
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => conversationDisplayName(c, currentTeamMemberId, t).toLowerCase().includes(q));
  }, [conversations, designatedApproverId, query, currentTeamMemberId, t]);

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
        onTossed(target ? conversationDisplayName(target, currentTeamMemberId, t) : '', inserted);
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

  // story #3203 — 결재자 이름 미해석 폴백도 같은 사람언어 문구로(예전엔 id 앞 8자 노출).
  const approverLabel = designatedApproverName ?? t('unknownMember');

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
        {/* story #3701(design 재-review, 페드루/유나) — 배너는 "목록 전체"에 대한 사실이라
            스크롤 영역 안에 있으면 후보가 늘어날 때 스크롤과 함께 시야 밖으로 밀려난다
            (하우스 선례 storyComparePartialNotice와 동형 — 목록 밖·위에 고정). 후보가 0건일
            땐 partial EmptyState가 같은 안내+재시도를 이미 말하므로 배너는 숨긴다(중복 문구·
            중복 재시도 버튼 방지). */}
        {!loading && partial && candidates.length > 0 ? (
          <div className="px-4">
            <div
              data-testid="toss-partial-notice"
              className="mb-1.5 flex items-center justify-between gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground"
            >
              <span>{t('approvalRequestTossPartialBanner')}</span>
              <button type="button" onClick={loadConversations} className="shrink-0 font-medium text-foreground underline underline-offset-2">
                {t('approvalRequestTossPartialRetry')}
              </button>
            </div>
          </div>
        ) : null}
        <div className="max-h-72 overflow-y-auto px-2 pb-2">
          {error ? <p role="alert" aria-live="assertive" className="px-2 pb-2 text-[11px] text-foreground">{error}</p> : null}
          {loading ? (
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          ) : candidates.length === 0 ? (
            partial ? (
              <EmptyState
                title={t('approvalRequestTossPartialEmptyTitle')}
                description={t('approvalRequestTossPartialEmptyBody')}
                action={
                  <Button size="sm" variant="outline" onClick={loadConversations}>
                    {t('approvalRequestTossPartialRetry')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title={t('approvalRequestTossEmptyTitle')}
                description={t('approvalRequestTossEmptyBody', { name: approverLabel })}
              />
            )
          ) : (
            candidates.map((c) => {
              const name = conversationDisplayName(c, currentTeamMemberId, t);
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
