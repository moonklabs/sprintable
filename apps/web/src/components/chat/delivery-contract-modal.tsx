'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

export type DeliveryLevel = 'all' | 'mentions' | 'mute';

interface PreferenceItem {
  scope_type: string;
  scope_id: string | null;
  channel: string;
  level: DeliveryLevel;
}

interface DeliveryContractModalProps {
  conversationId: string;
  conversationType: 'dm' | 'group';
  freeResponse: boolean;
  onClose: () => void;
  /** free_response가 바뀌면 부모(conversation meta)도 갱신 — 헤더 등 다른 표면과 어긋나지 않게. */
  onFreeResponseChange: (next: boolean) => void;
  /** story #2623 pre-work(BE #3037 action_auth와 같은 org role 축 — admin/owner만) — 지정되면
   * "나(호출자)"가 아니라 이 멤버의 계약을 대신 조회/편집한다(GET/PUT `?member_id=`). BE는
   * story 933248fa(webhook admin override)와 동일 서버측 재해소+403 fail-closed 패턴을
   * 적용할 예정(그라운딩 완료·PO 08-14 승인, 착지 대기) — 그때까지 이 prop은 준비만 해 둔다.
   * 무권한 요청은 BE가 403으로 거부한다(FE는 재구성하지 않고 에러 그대로 보여준다, 기존
   * handleSaveLevel catch가 이미 그 계약). undefined면 지금처럼 자기 자신(회귀 없음). */
  targetMemberId?: string;
  /** 대리 편집 중임을 헤더에 드러내는 라벨(예: 에이전트 이름) — targetMemberId와 짝. */
  targetMemberLabel?: string;
}

// story #2621 v1 — 채널은 이 대화 UI 축 하나(sse, 실시간 인앱 알림)만 편집한다. discord/telegram/
// in_app은 조직 설정(notification-settings, #2272)의 별개 표면 — 여기서 과펼침하지 않는다(PO 확定).
const EDITED_CHANNEL = 'sse';

const LEVELS: DeliveryLevel[] = ['all', 'mentions', 'mute'];

/**
 * story #2621 v1 — 전달 계약 편집(대화 설정). 신규 API 없음(AC②) — 기존
 * `GET/PUT /api/notification-preferences`(scope_type=conversation·channel=sse)와
 * `PATCH /api/conversations/{id}`(free_response)를 그대로 재사용한다.
 *
 * story #2623 pre-work — `targetMemberId`가 있으면 "나(호출자)" 대신 그 멤버의 이 대화
 * 수신 레벨을 대신 조회/편집한다(GET/PUT에 `member_id` 실어 보냄). BE는 아직 self-only
 * 하드고정이라(그라운딩 확認·933248fa 동형 처방 승인·착지 대기) 이 경로는 BE 착지
 * 前까지는 무권한 403(또는 무시)으로 떨어질 수 있다 — prop과 배선만 미리 갖춰 둔다.
 * free_response 토글은 대리 편집 스코프 밖(이 스토리 AC가 대화 수신 레벨만 다룸) —
 * targetMemberId가 있으면 그 축 자체를 숨긴다(편집 가능해 보이는데 실은 conversation
 * 전역 설정이라 다른 참가자에게도 영향을 주는 축을 대리 편집 UI에 얹지 않는다).
 *
 * free_response는 group에서만 의미 있다(DM은 항상 default=all — channel_router.py
 * docstring) — dm이면 그 축 자체를 안 보여준다.
 */
export function DeliveryContractModal({
  conversationId, conversationType, freeResponse, onClose, onFreeResponseChange, targetMemberId, targetMemberLabel,
}: DeliveryContractModalProps) {
  const t = useTranslations('chats');
  const tc = useTranslations('common');
  const [level, setLevel] = useState<DeliveryLevel>('all');
  const [hasOverride, setHasOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localFreeResponse, setLocalFreeResponse] = useState(freeResponse);

  useEffect(() => {
    let cancelled = false;
    const url = targetMemberId
      ? `/api/notification-preferences?member_id=${encodeURIComponent(targetMemberId)}`
      : '/api/notification-preferences';
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { data?: PreferenceItem[] } | PreferenceItem[] } | null) => {
        if (cancelled || !json) return;
        const list = Array.isArray(json.data) ? json.data : (json.data as { data?: PreferenceItem[] })?.data ?? [];
        const mine = list.find(
          (p) => p.scope_type === 'conversation' && p.scope_id === conversationId && p.channel === EDITED_CHANNEL,
        );
        if (mine) { setLevel(mine.level); setHasOverride(true); }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId, targetMemberId]);

  const handleSaveLevel = async (next: DeliveryLevel) => {
    const prev = level;
    setLevel(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/notification-preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: [{ scope_type: 'conversation', scope_id: conversationId, channel: EDITED_CHANNEL, level: next }],
          ...(targetMemberId ? { member_id: targetMemberId } : {}),
        }),
      });
      if (!res.ok) throw new Error('save failed');
      setHasOverride(true);
    } catch {
      setLevel(prev);
      setError(t('deliveryContractSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleFreeResponse = async () => {
    const next = !localFreeResponse;
    setLocalFreeResponse(next);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ free_response: next }),
      });
      if (!res.ok) throw new Error('save failed');
      onFreeResponseChange(next);
    } catch {
      setLocalFreeResponse(!next);
      setError(t('deliveryContractSaveFailed'));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md overflow-hidden rounded-xl p-0" showCloseButton={false}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="text-sm font-semibold text-foreground">{t('deliveryContractTitle')}</DialogTitle>
            {/* story #2623 pre-work — 대리 편집 중임을 항상 눈에 띄게(누구 계약을 만지고 있는지
                착각하면 사고 — «본인 계약인 줄 알고 바꿨는데 사실 남의 것»류 방지). */}
            {targetMemberId && (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {t('deliveryContractEditingOnBehalfOf', { name: targetMemberLabel ?? targetMemberId })}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('deliveryContractLoading')}</div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="mb-1 text-xs font-medium text-foreground">{t('deliveryContractLevelLabel')}</p>
                {/* 유나 design 소견(#3012) — 헤더 Bell/BellOff(conversation.muted_at, 화면 표시만
                    억제)와 이 레벨(notification_preferences, 전달 자체를 결정)은 서로 다른 축이다
                    (channel_router.py가 muted_at을 참조하지 않음, 코드로 확認) — 혼동 방지 문구. */}
                <p className="mb-1 text-[11px] text-muted-foreground">{t('deliveryContractLevelHint')}</p>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  {hasOverride ? t('deliveryContractLevelHasOverride') : t('deliveryContractLevelDefault')}
                </p>
                <div className="flex gap-1.5">
                  {LEVELS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      disabled={saving}
                      onClick={() => void handleSaveLevel(l)}
                      aria-pressed={level === l}
                      className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition ${
                        level === l
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {t(`deliveryContractLevel_${l}`)}
                    </button>
                  ))}
                </div>
              </div>

              {conversationType === 'group' && !targetMemberId && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{t('deliveryContractFreeResponseLabel')}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{t('deliveryContractFreeResponseDesc')}</p>
                  </div>
                  <Switch
                    checked={localFreeResponse}
                    onCheckedChange={() => void handleToggleFreeResponse()}
                    aria-label={t('deliveryContractFreeResponseLabel')}
                  />
                </div>
              )}

              {/* story #2621 AC③ 부분충족 — 판정 사유(chain-expired 등)는 현재 Cloud Logging에만
                  있어(BE #2603/#2608 실측) 이 UI가 실시간으로 보여줄 수 없다. 조용히 숨기는 대신
                  그 한계 자체를 선언 — #2617 후속(BE가 사유를 조회 가능한 형태로 노출)의 몫. */}
              <p className="text-[11px] text-muted-foreground">{t('deliveryContractReasonGapNote')}</p>

              {error && <p role="alert" aria-live="assertive" className="text-xs text-destructive">{error}</p>}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>{tc('close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
