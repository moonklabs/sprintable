'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchWithAuth } from '@/lib/db/client';
import { getEntityHref } from '@/components/chat/embed-card';
import { isLinkableRef } from '@/components/verify/evidence-section';
import { translateEntityStatus } from '@/components/chat/entity-status-labels';
import { pickEulReulJosa, pickEuroJosa, pickIGaJosa } from '@/lib/korean-particle';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import type { EvidenceItem, EvidenceType } from '@/services/verify';
import type { TodayNeedsMeItem } from '@/components/org-briefing/derive-today';

interface ArtifactDetail {
  title: string | null;
  latestVersionNumber: number | null;
}

export interface ChatV3WorkItemRef {
  type: 'story' | 'task';
  id: string;
}

// story #3990(E-UX-OVERHAUL·「대화」 구현 5/N) — 「근거」·「이력」 실값. work-list-
// detail-panel.tsx(스토리 #3976/#3988, 이 브랜치엔 아직 안 온 스택)가 쓰는 것과 같은
// 판정식·같은 낱말을 이 브랜치 자체 사본으로 재사용한다(교차 브랜치 import 불가 — 두
// 스택이 합쳐질 때 한 모듈로 공용화하는 건 후속 정리 몫, PO 낱말표는 "같은 말을
// 쓰라"는 뜻이지 지금 없는 심볼을 import하라는 뜻이 아니다).
interface ActivityLogItem {
  id: string;
  actor_name: string | null;
  action: string;
  entity_title: string | null;
  created_at: string;
  context: { old_status?: string; new_status?: string; fields?: string[] } | null;
}
interface ActivityLogResponse {
  items: ActivityLogItem[];
}

const HISTORY_FIELD_LABEL_KEY: Record<string, string> = {
  title: 'historyFieldTitle',
  assignee_id: 'historyFieldAssignee',
  epic_id: 'historyFieldEpic',
  sprint_id: 'historyFieldSprint',
};

function historyClaim(
  item: ActivityLogItem, workItemType: 'story' | 'task', t: ReturnType<typeof useTranslations>, locale: string,
): string {
  if (item.action.endsWith('_created')) return t('historyActionCreated');

  const oldStatus = item.context?.old_status;
  const newStatus = item.context?.new_status;
  if (oldStatus && newStatus) {
    const oldLabel = translateEntityStatus(workItemType, oldStatus) ?? oldStatus;
    const newLabel = translateEntityStatus(workItemType, newStatus) ?? newStatus;
    const newDisplay = locale === 'ko' ? `${newLabel}${pickEuroJosa(newLabel)}` : newLabel;
    return t('historyStatusChanged', { old: oldLabel, new: newDisplay });
  }

  const fields = item.context?.fields ?? [];
  const knownFieldKey = fields.map((f) => HISTORY_FIELD_LABEL_KEY[f]).find((k): k is string => !!k);
  const fieldLabel = knownFieldKey ? t(knownFieldKey) : null;
  if (fieldLabel) {
    const display = locale === 'ko' ? `${fieldLabel}${pickEulReulJosa(fieldLabel)}` : fieldLabel;
    return t('historyFieldChanged', { field: display });
  }

  return t('historyOtherChange');
}

// BE _CLIENT_CREATABLE_TYPES 포함 evidence.py 전체 타입 라벨 미러(evidence-section.tsx
// TYPE_LABEL_KEY와 동형, 그 상수는 export 안 돼 있어 로컬 사본).
const EVIDENCE_TYPE_LABEL_KEY: Record<EvidenceType, string> = {
  url: 'evidenceTypeUrl',
  file: 'evidenceTypeFile',
  pr: 'evidenceTypePr',
  deploy: 'evidenceTypeDeploy',
  metric: 'evidenceTypeMetric',
  report: 'evidenceTypeReport',
  gate_approval: 'evidenceTypeGateApproval',
};

type SectionState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: T[] };

/**
 * story #3990 — 근거·이력 둘 다 이 하나의 훅으로(모양이 완전히 같다: idle/loading/
 * error/ready 4상태 + 요청식별 ref 가드). 가드는 4381 C1(PO 판정 2026-09-17 03:49Z,
 * work-list-detail-panel.tsx `publicationsRequestForRef`)과 같은 클래스 — 이전
 * work item의 늦은 응답이 그 사이 옮겨간 새 work item 화면을 덮어쓰지 않게, 응답
 * 도착 시 "그 응답이 요청될 때의 work item 키"와 "지금 최신 키"를 대조해 다르면 버린다.
 */
function useWorkItemScopedList<T>(
  workItemRef: ChatV3WorkItemRef | null,
  buildUrl: (ref: ChatV3WorkItemRef) => string,
  extractItems: (data: unknown) => T[],
): [SectionState<T>, () => void] {
  const [state, setState] = useState<SectionState<T>>({ kind: 'idle' });
  const requestKeyRef = useRef<string | null>(null);

  const run = useCallback((ref: ChatV3WorkItemRef) => {
    const key = `${ref.type}:${ref.id}`;
    requestKeyRef.current = key;
    setState({ kind: 'loading' });
    void fetchWithAuth(buildUrl(ref))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: { data?: unknown }) => {
        if (requestKeyRef.current !== key) return;
        setState({ kind: 'ready', items: extractItems(json.data) });
      })
      .catch(() => {
        if (requestKeyRef.current !== key) return;
        setState({ kind: 'error' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buildUrl/extractItems는 호출부가 매 렌더 새로 만드는 인라인 함수라 deps로 넣으면 매 렌더 재생성된다. run 자체는 effect가 workItemRef 변경 시에만 최신 클로저를 다시 잡아 부르므로 무방(useArtifactDetail과 동형 트레이드오프).
  }, []);

  useEffect(() => {
    if (!workItemRef) {
      requestKeyRef.current = null;
      setState({ kind: 'idle' });
      return;
    }
    run(workItemRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workItemRef "값"(type+id)만 보고 반응한다 — 부모가 매 렌더 새 객체를 만들어도(#3990 chat-v3-screen.tsx setState 갱신 시) 값이 같으면 재조회 0.
  }, [workItemRef?.type, workItemRef?.id]);

  const retry = useCallback(() => { if (workItemRef) run(workItemRef); }, [workItemRef, run]);

  return [state, retry];
}

/**
 * story #3972 AC5 — 맥락 패널 4절. 페드루 PO 판정(부재 8): 열린 산출물=메시지
 * `references[]` 최근 artifact를 FE가 파생(부모가 넘겨준 artifactId, BE 0) ·
 * 관련=오늘 스냅샷 캐시로 `conversation_id` 역조회(BE 0, #3971 그라운딩이 찾은
 * 그 역방향 링크). story #3990(#3971 부재 4·5 정정) — 근거·이력도 같은 방식으로
 * 채운다: references 최근 story/task 참조(workItemRef, 위 messages 컴포넌트가
 * 파생)로 기존 evidence·activity-logs API를 그대로 호출(useWorkItemScopedList).
 */
function useArtifactDetail(artifactId: string | null): ArtifactDetail | null {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);

  useEffect(() => {
    setDetail(null);
    if (!artifactId) return;
    let cancelled = false;
    void (async () => {
      try {
        const previewRes = await fetchWithAuth(`/api/visual-artifacts/preview?id=${encodeURIComponent(artifactId)}`);
        if (!previewRes.ok) throw new Error('preview failed');
        const previewJson = (await previewRes.json()) as { data?: { projectId?: string } };
        const projectId = previewJson.data?.projectId;
        if (!projectId) throw new Error('no projectId');
        const detailRes = await fetchWithAuth(`/api/visual-artifacts/${artifactId}`, {
          headers: { 'X-Project-Id': projectId },
        });
        if (!detailRes.ok) throw new Error('detail failed');
        const detailJson = (await detailRes.json()) as { data?: { title?: string | null; latest_version_number?: number } };
        if (cancelled) return;
        setDetail({
          title: detailJson.data?.title ?? null,
          latestVersionNumber: detailJson.data?.latest_version_number ?? null,
        });
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => { cancelled = true; };
  }, [artifactId]);

  return detail;
}

export function ChatV3ContextPanel({ conversationId, openArtifactId, workItemRef, needsMe, todayV3Enabled }: {
  conversationId: string;
  openArtifactId: string | null;
  // story #3990 — 「근거」·「이력」이 스코프할 일. null=아직 이 대화에 이어진 story/
  // task 참조가 없다(구조 사실 — #3971 부재 4·5 정정으로 새 BE 0, 기존 evidence·
  // activity-logs API를 이 값으로 그대로 부른다).
  workItemRef: ChatV3WorkItemRef | null;
  // 페드루 PO 지시(2026-09-17 00:08Z, PR #4370 CHANGES) — 오늘 스냅샷은 화면 최상위
  // (`ChatV3Screen`)에서 1콜만 하고 이 패널·이벤트 카드(서명 버튼 막다른 길 방지)가
  // 같이 나눠 쓴다(중복 콜 0).
  needsMe: TodayNeedsMeItem[];
  // story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — TODAY_V3_ENABLED
  // OFF면 「오늘」 링크가 404라 옛 큐(/inbox)로 보낸다.
  todayV3Enabled: boolean;
}) {
  const t = useTranslations('chatV3');
  const tVerify = useTranslations('verify');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { tz } = resolveDisplayTimezone();
  const artifact = useArtifactDetail(openArtifactId);
  const relatedNeedsMe = needsMe.find((item) => item.conversationId === conversationId) ?? null;
  const todayHref = todayV3Enabled ? '/today' : '/inbox';

  const [evidence, retryEvidence] = useWorkItemScopedList<EvidenceItem>(
    workItemRef,
    (ref) => `/api/evidence?work_item_id=${ref.id}&work_item_type=${ref.type}`,
    (data) => (Array.isArray(data) ? data as EvidenceItem[] : []),
  );
  const [history, retryHistory] = useWorkItemScopedList<ActivityLogItem>(
    workItemRef,
    (ref) => `/api/activity-logs?entity_type=${ref.type}&entity_id=${ref.id}`,
    (data) => {
      const items = (data as ActivityLogResponse | undefined)?.items;
      return Array.isArray(items) ? items as ActivityLogItem[] : [];
    },
  );
  // story #3990 — 「기준」 줄의 일 제목. 별도 3번째 콜은 AC5 콜 예산(+2까지만 허용)을
  // 넘기니, 이력 응답이 이미 들고 오는 entity_title(BE 해소 필드, activity_logs.py)에서
  // 공짜로 얻는다 — 이력이 아직 없거나(0건) 로딩/실패 中이면 이 줄 자체를 생략한다
  // (모른다≠지어낸다 — 제목 없이 "기준" 줄만 없는 건 근거·이력 절 자체엔 영향 0).
  const scopeTitle = history.kind === 'ready' ? (history.items[0]?.entity_title ?? null) : null;
  const scopeHref = workItemRef && scopeTitle ? getEntityHref(workItemRef.type, workItemRef.id) : null;

  return (
    <section className="flex w-[340px] shrink-0 flex-col bg-card" data-testid="chat-v3-context-panel">
      <div className="flex h-[52px] shrink-0 items-center border-b border-border px-4">
        <h2 className="text-[13px] font-bold text-muted-foreground">{t('contextPanelTitle')}</h2>
      </div>
      <div className="flex-1 space-y-4 overflow-auto p-4">
        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextOpenArtifactLabel')}</p>
          {openArtifactId ? (
            artifact ? (
              <Card className="p-3" data-testid="chat-v3-open-artifact-card">
                <p className="truncate text-[13px] font-medium text-foreground">{artifact.title ?? t('untitledArtifact')}</p>
                {artifact.latestVersionNumber !== null ? (
                  <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t('artifactVersion', { version: artifact.latestVersionNumber })}</p>
                ) : null}
              </Card>
            ) : (
              <div className="h-16 animate-pulse rounded-md bg-muted/40" aria-hidden="true" />
            )
          ) : (
            <p className="text-xs text-muted-foreground">{t('contextEmptySection')}</p>
          )}
        </div>

        {scopeTitle ? (
          scopeHref ? (
            <Link href={scopeHref} className="-mb-2 block text-[11px] text-muted-foreground hover:underline" data-testid="chat-v3-context-scope">
              {t('contextWorkItemScopeLabel', { title: scopeTitle })}
            </Link>
          ) : (
            <p className="-mb-2 text-[11px] text-muted-foreground" data-testid="chat-v3-context-scope">
              {t('contextWorkItemScopeLabel', { title: scopeTitle })}
            </p>
          )
        ) : null}

        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextEvidenceLabel')}</p>
          {!workItemRef ? (
            <p className="text-xs text-muted-foreground" data-testid="chat-v3-evidence-no-work-item">{t('contextNoLinkedWorkItem')}</p>
          ) : evidence.kind === 'idle' || evidence.kind === 'loading' ? (
            <div className="space-y-1.5" data-testid="chat-v3-evidence-loading">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : evidence.kind === 'error' ? (
            <div className="space-y-1.5" data-testid="chat-v3-evidence-error">
              <p role="alert" className="text-xs text-destructive">{t('contextEvidenceLoadError')}</p>
              <Button size="sm" variant="outline" onClick={retryEvidence} data-testid="chat-v3-evidence-retry">{tCommon('retry')}</Button>
            </div>
          ) : evidence.items.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="chat-v3-evidence-empty">{t('contextEmptySection')}</p>
          ) : (
            <ul className="space-y-1.5" data-testid="chat-v3-evidence-list">
              {evidence.items.map((item) => (
                <li key={item.id} className="text-xs">
                  <span className="text-muted-foreground">{tVerify(EVIDENCE_TYPE_LABEL_KEY[item.type])}</span>
                  {isLinkableRef(item.ref) ? (
                    <a href={item.ref} target="_blank" rel="noreferrer" className="ml-1.5 truncate text-primary underline-offset-2 hover:underline">
                      {item.note ?? item.ref}
                    </a>
                  ) : (
                    <span className="ml-1.5 truncate text-foreground">{item.note ?? item.ref}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextHistoryLabel')}</p>
          {!workItemRef ? (
            <p className="text-xs text-muted-foreground" data-testid="chat-v3-history-no-work-item">{t('contextNoLinkedWorkItem')}</p>
          ) : history.kind === 'idle' || history.kind === 'loading' ? (
            <div className="space-y-1.5" data-testid="chat-v3-history-loading">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : history.kind === 'error' ? (
            <div className="space-y-1.5" data-testid="chat-v3-history-error">
              <p role="alert" className="text-xs text-destructive">{t('contextHistoryLoadError')}</p>
              <Button size="sm" variant="outline" onClick={retryHistory} data-testid="chat-v3-history-retry">{tCommon('retry')}</Button>
            </div>
          ) : history.items.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="chat-v3-history-empty">{t('contextEmptySection')}</p>
          ) : (
            <ul className="space-y-1.5" data-testid="chat-v3-history-list">
              {history.items.map((item) => {
                const actorName = item.actor_name ?? t('historyUnknownActor');
                return (
                  <li key={item.id} className="text-xs">
                    <span className="text-foreground">{actorName}{pickIGaJosa(actorName)} {historyClaim(item, workItemRef.type, t, locale)}</span>
                    <span className="ml-1.5 text-muted-foreground">{formatRelativeTime(item.created_at, locale, tz)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextRelatedLabel')}</p>
          {relatedNeedsMe ? (
            <Link href={todayHref} className="block rounded-md bg-primary/10 px-3 py-2.5 text-[12.5px] text-primary" data-testid="chat-v3-related-today-link">
              {t('contextRelatedTodayLink')}
            </Link>
          ) : (
            <p className="text-xs text-muted-foreground">{t('contextEmptySection')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
