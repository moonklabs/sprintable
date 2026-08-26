'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/shared/avatar';
import { AvatarCropper } from '@/components/shared/avatar-cropper';
import { AVATAR_ALLOWED_CONTENT_TYPES, AVATAR_MAX_BYTES, removeAvatar, uploadAvatar } from '@/lib/avatar-upload';

type Stage = { kind: 'idle' } | { kind: 'cropping'; url: string } | { kind: 'uploading'; pct: number };

/**
 * story #2887(S2g) — 아바타 설정·수정 표면(드롭존+크롭+진행률/에러). 휴먼 프로필(설정)과
 * 에이전트 카드(workforce/[id]) 양쪽이 동일 컴포넌트를 소비 — 목업 규칙("설정 표면 = 양쪽").
 */
export function AvatarEditCard({
  memberId, name, avatarUrl, actorType, onUpdated, bigSize = 72,
}: {
  memberId: string;
  name: string;
  avatarUrl: string | null;
  actorType: 'human' | 'agent';
  onUpdated: (newAvatarUrl: string | null) => void;
  bigSize?: number;
}) {
  const t = useTranslations('settings');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const acceptFile = useCallback((file: File) => {
    setError(null);
    if (!(AVATAR_ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setError(t('avatarUnsupportedType'));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError(t('avatarTooLarge'));
      return;
    }
    setStage({ kind: 'cropping', url: URL.createObjectURL(file) });
  }, [t]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) acceptFile(file);
  }, [acceptFile]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  }, [acceptFile]);

  const handleCropCancel = useCallback(() => {
    if (stage.kind === 'cropping') URL.revokeObjectURL(stage.url);
    setStage({ kind: 'idle' });
  }, [stage]);

  const handleCropApply = useCallback(async (blob: Blob) => {
    if (stage.kind === 'cropping') URL.revokeObjectURL(stage.url);
    setStage({ kind: 'uploading', pct: 0 });
    setError(null);
    try {
      const newUrl = await uploadAvatar(memberId, blob, 'image/png', (pct) => setStage({ kind: 'uploading', pct }));
      setStage({ kind: 'idle' });
      onUpdated(newUrl);
    } catch {
      setStage({ kind: 'idle' });
      setError(t('avatarUploadError'));
    }
  }, [stage, memberId, onUpdated, t]);

  const handleRemove = useCallback(async () => {
    setError(null);
    try {
      await removeAvatar(memberId);
      onUpdated(null);
    } catch {
      setError(t('avatarRemoveError'));
    }
  }, [memberId, onUpdated, t]);

  if (stage.kind === 'cropping') {
    return <AvatarCropper imageUrl={stage.url} onCancel={handleCropCancel} onApply={(blob) => void handleCropApply(blob)} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Avatar name={name} avatarUrl={avatarUrl} actorType={actorType} size={bigSize} />
        <div>
          <div className="mb-2 text-sm font-semibold text-foreground">{name}</div>
          <div className="flex gap-2">
            <Button size="sm" disabled={stage.kind === 'uploading'} onClick={() => inputRef.current?.click()}>
              {t('avatarChange')}
            </Button>
            {avatarUrl ? (
              <Button size="sm" variant="ghost" className="text-destructive" disabled={stage.kind === 'uploading'} onClick={() => void handleRemove()}>
                {t('avatarRemove')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ALLOWED_CONTENT_TYPES.join(',')}
        className="hidden"
        onChange={handleFileInput}
      />

      {stage.kind === 'uploading' ? (
        <div className="text-xs text-muted-foreground">{t('avatarUploading', { pct: stage.pct })}</div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`cursor-pointer rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground transition-colors ${
            dragOver ? 'border-info bg-info/5' : 'border-border bg-muted'
          }`}
        >
          {t('avatarDropHint')}
        </div>
      )}

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">{t('avatarConstraint')}</p>
      {error && <p role="alert" aria-live="assertive" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
