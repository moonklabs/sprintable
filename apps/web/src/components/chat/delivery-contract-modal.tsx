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
 * 편집 대상은 "나(호출자)의 이 대화 수신 레벨"뿐이다 — notification_preferences는
 * 애초에 caller 자신의 설정만 다루는 API(BE `_get_member`가 인증 주체로 고정)라 다른
 * 멤버의 레벨을 여기서 바꿀 수 없다(그건 멤버 관점 요약 뷰의 몫, 이 스토리의 다른 절반).
 *
 * free_response는 group에서만 의미 있다(DM은 항상 default=all — channel_router.py
 * docstring) — dm이면 그 축 자체를 안 보여준다.
 */
export function DeliveryContractModal({
  conversationId, conversationType, freeResponse, onClose, onFreeResponseChange,
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
    fetch('/api/notification-preferences')
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
  }, [conversationId]);

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
          <DialogTitle className="text-sm font-semibold text-foreground">{t('deliveryContractTitle')}</DialogTitle>
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

              {conversationType === 'group' && (
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
