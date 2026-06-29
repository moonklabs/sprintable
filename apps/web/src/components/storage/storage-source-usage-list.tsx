'use client';

import Link from 'next/link';
import { ArrowUpRight, Bookmark, FileText, MessageSquare, Paperclip, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { resolveDeeplinkHref } from '@/lib/storage/format';
import type { AssetSourceLink, AssetSourceLinkType } from '@/lib/storage/types';

interface StorageSourceUsageListProps {
  links: AssetSourceLink[];
  /** 삭제 다이얼로그용 컴팩트 변형(패딩 7/9, 서브라인 1줄). */
  compact?: boolean;
}

const TYPE_ICON: Record<AssetSourceLinkType, LucideIcon> = {
  story: Bookmark,
  doc: FileText,
  conversation_message: MessageSquare,
  manual: Paperclip,
};

// 목업 `.uic.*` 토큰 매핑. conversation: --brand-soft 유틸리티 부재 → bg-brand/15 로 근사(NOTE).
const TYPE_TINT: Record<AssetSourceLinkType, string> = {
  story: 'bg-info/15 text-info',
  doc: 'bg-success/15 text-success',
  conversation_message: 'bg-brand/15 text-brand',
  manual: 'bg-muted text-muted-foreground',
};

export function StorageSourceUsageList({ links, compact = false }: StorageSourceUsageListProps) {
  const t = useTranslations('storage');

  const typeLabel = (type: AssetSourceLinkType): string => {
    switch (type) {
      case 'story':
        return t('typeStory');
      case 'doc':
        return t('typeDoc');
      case 'conversation_message':
        return t('typeConversation');
      case 'manual':
        return t('typeManual');
    }
  };

  const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}` : id);

  const subtitleFor = (link: AssetSourceLink): string | null => {
    switch (link.type) {
      case 'story':
      case 'doc':
        return `${typeLabel(link.type)} · ${shortId(link.id)}`;
      case 'conversation_message':
        return typeLabel(link.type);
      case 'manual':
        return null;
    }
  };

  return (
    <div className="space-y-[7px]">
      {links.map((link, idx) => {
        const href = link.type === 'manual' ? null : resolveDeeplinkHref(link);
        const isLinked = href != null;
        const subtitle = subtitleFor(link);
        const Icon = TYPE_ICON[link.type];
        const title = link.type === 'conversation_message' ? `"${link.title}"` : link.title;

        const inner = (
          <>
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-[0.375rem]',
                TYPE_TINT[link.type],
              )}
            >
              <Icon className="size-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-foreground">{title}</span>
              {subtitle ? (
                <span
                  className={cn(
                    'mt-0.5 block text-[11px] text-muted-foreground',
                    compact ? 'truncate' : '',
                  )}
                >
                  {subtitle}
                </span>
              ) : null}
            </span>
            {isLinked ? <ArrowUpRight className="mt-[3px] size-4 shrink-0 text-muted-foreground/40" /> : null}
          </>
        );

        const baseClass = cn(
          'flex items-start gap-[9px] rounded-[0.5rem] border border-border bg-background',
          compact ? 'px-[9px] py-[7px]' : 'px-[10px] py-[9px]',
        );

        if (isLinked && href) {
          return (
            <Link key={`${link.type}-${link.id}-${idx}`} href={href} className={cn(baseClass, 'cursor-pointer hover:bg-muted')}>
              {inner}
            </Link>
          );
        }

        // manual / 링크 불가 → 평문(기본 커서·hover 없음·arrow 없음)
        return (
          <div key={`${link.type}-${link.id}-${idx}`} className={cn(baseClass, 'cursor-default')}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
