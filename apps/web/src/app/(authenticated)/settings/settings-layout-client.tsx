'use client';

import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { SettingsSidebar } from '@/components/settings/settings-sidebar';
import { GlassPanel } from '@/components/ui/glass-panel';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { cn } from '@/lib/utils';

interface SettingsLayoutClientProps {
  children: React.ReactNode;
  isAdmin: boolean;
  currentProjectId?: string;
}

export function SettingsLayoutClient({ children, isAdmin, currentProjectId }: SettingsLayoutClientProps) {
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');

  return (
    <div className="flex flex-1">
      {/* Desktop sidebar (lg+) */}
      <div className="hidden lg:block">
        <SettingsSidebar isAdmin={isAdmin} currentProjectId={currentProjectId} />
      </div>

      {/* Mobile list view (< lg) */}
      {mobileView === 'list' && (
        <div className="flex-1 p-3 lg:hidden">
          <GlassPanel className="flex flex-col">
            <SettingsSidebar
              isAdmin={isAdmin}
              currentProjectId={currentProjectId}
              onItemClick={() => setMobileView('detail')}
            />
            <div className="border-t border-white/10 px-4 py-3">
              <LocaleSwitcher />
            </div>
          </GlassPanel>
        </div>
      )}

      {/* Settings content: desktop always, mobile only in detail view */}
      <main className={cn('min-w-0 flex-1 p-4 lg:p-6', mobileView === 'list' && 'hidden lg:block')}>
        {/* Mobile detail back button */}
        <div className="mb-4 flex items-center gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileView('list')}
            className="flex items-center gap-1 py-1 text-sm text-[color:var(--operator-muted)] hover:text-[color:var(--operator-foreground)]"
          >
            <ChevronLeft className="size-4" />
            Settings
          </button>
        </div>
        {children}
      </main>
    </div>
  );
}
