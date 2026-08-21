'use client';

/**
 * GNB 사이드바 footer 「사업자 정보」 접이식 노출 (story #2870).
 *
 * 로컬 useState 토글 — collapsible 프리미티브 신규 의존성 0. default 접힘, 클릭 시 토글
 * 바로 아래로 인라인 펼침(오버레이 아님) — footer 흐름 안에서 SidebarContent(nav)가
 * 세로 공간을 흡수한다. 값은 전부 SSOT(lib/legal/business-info.ts)에서만 가져온다.
 */

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, ChevronDown } from 'lucide-react';
import { BusinessInfoList, LegalLinks } from '@/components/legal/legal-footer';

export function BusinessInfoDisclosure() {
  const t = useTranslations('legal');
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sidebar-foreground/60 transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <Building2 className="size-4 shrink-0" />
        <span className="flex-1 truncate text-xs">{t('businessInfoHeading')}</span>
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={panelId} className="max-h-[45vh] overflow-y-auto px-2 py-2">
          <BusinessInfoList />
          <div className="mt-2 border-t border-sidebar-border/60 pt-2">
            <p className="mb-1 text-[10px] font-medium text-sidebar-foreground/60">{t('policiesHeading')}</p>
            <LegalLinks className="text-xs text-sidebar-foreground/60" />
          </div>
        </div>
      )}
    </div>
  );
}
