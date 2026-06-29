'use client';

import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { avatarColor, initials } from '@/lib/storage/format';
import type { AssetCreatedBy } from '@/lib/storage/types';

interface StorageUploaderAvatarProps {
  createdBy: AssetCreatedBy | null;
  size?: number;
}

/**
 * 업로더 아바타 3-state:
 *  (1) avatar_url 있음 → 원형 이미지
 *  (2) 업로더 있음·이미지 없음 → 이니셜 원형(이름/ id 결정론적 배경색)
 *  (3) 업로더 없음 → 시스템 칩(muted)
 */
export function StorageUploaderAvatar({ createdBy, size = 22 }: StorageUploaderAvatarProps) {
  const t = useTranslations('storage');

  if (!createdBy) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-[7px] py-px text-[11px] font-semibold text-muted-foreground">
        <Bot className="size-3" />
        {t('system')}
      </span>
    );
  }

  if (createdBy.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={createdBy.avatar_url}
        alt={createdBy.name}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full font-semibold text-white',
        avatarColor(createdBy.id || createdBy.name),
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-label={createdBy.name}
    >
      {initials(createdBy.name)}
    </span>
  );
}
