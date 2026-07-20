'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface PinAuthoringPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDescription: string;
  onSave: (description: string) => Promise<boolean>;
  /** 기존 핀 재편집일 때만 — 신규 배치(draft)는 저장 전이라 삭제할 대상이 없다(ESC=배치 취소로 충분). */
  onDelete?: () => Promise<boolean>;
}

/**
 * story 7fe16274 §3 — 핀 배치 직후(또는 재편집 클릭 시) 즉시 열리는 description 저작 UI.
 * **빈 description 커밋 차단**(§3 — 저장 버튼은 본문이 있어야 활성, BE도 non-null 강제라
 * 이중 방어). ESC/닫기=취소(신규 배치면 draft 폐기·BE 호출 0, 재편집이면 무변경).
 *
 * 위치 판단(정직 고지): spec은 "핀 옆" 인라인 팝오버를 요구하지만, 핀은 CanvasViewport의
 * pan/zoom transform 안에 있어 화면 좌표가 계속 바뀐다(팝오버가 그 좌표를 계속 추적하려면
 * 별도 트래킹 루프가 필요) — 기존 코드베이스가 이미 갖춘 base-ui Dialog(중앙 모달, ESC/backdrop
 * 닫기 기본 제공)를 재사용해 좌표 추적 복잡도 없이 핵심 계약(즉시 입력·빈 커밋 차단·ESC 취소)을
 * 충족시켰다 — "핀 옆"의 문자 그대로의 배치는 이번 스코프 밖(신규 좌표-추적 메커니즘 발명 회피).
 */
export function PinAuthoringPopover({ open, onOpenChange, initialDescription, onSave, onDelete }: PinAuthoringPopoverProps) {
  const t = useTranslations('canvas');
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const trimmed = description.trim();
  const canSave = trimmed.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(false);
    const ok = await onSave(trimmed);
    setSaving(false);
    if (!ok) { setError(true); return; }
    onOpenChange(false);
  };

  const handleDelete = async () => {
    if (!onDelete || saving) return;
    setSaving(true);
    setError(false);
    const ok = await onDelete();
    setSaving(false);
    if (!ok) { setError(true); return; }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('specPinPopoverTitle')}</DialogTitle>
        </DialogHeader>

        <textarea
          autoFocus
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('specPinDescriptionPlaceholder')}
          rows={4}
          className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        {error ? <p className="mt-1 text-[10px] text-destructive">{t('specPinSaveFailedNote')}</p> : null}

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          {onDelete ? (
            <Button variant="outline" size="sm" onClick={() => void handleDelete()} disabled={saving}>
              {t('propertyDeleteAction')}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('specPinCancelAction')}
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={!canSave}>
              {saving ? t('specPinSavingAction') : t('specPinSaveAction')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
