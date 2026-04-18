'use client';

import { useState } from 'react';
import { Menu } from 'lucide-react';
import { SettingsSidebar } from '@/components/settings/settings-sidebar';
import { GlassPanel } from '@/components/ui/glass-panel';

interface SettingsLayoutClientProps {
  children: React.ReactNode;
  isAdmin: boolean;
  currentProjectId?: string;
}

export function SettingsLayoutClient({ children, isAdmin, currentProjectId }: SettingsLayoutClientProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex flex-1">
      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px] md:hidden"
          aria-label="Close menu"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-y-0 left-0 z-50 w-[min(80vw,18rem)] p-3 md:hidden">
          <GlassPanel className="flex h-full flex-col overflow-y-auto">
            <SettingsSidebar
              isAdmin={isAdmin}
              currentProjectId={currentProjectId}
              onItemClick={() => setDrawerOpen(false)}
            />
          </GlassPanel>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <SettingsSidebar isAdmin={isAdmin} currentProjectId={currentProjectId} />
      </div>

      {/* Main content */}
      <main className="min-w-0 flex-1 p-4 md:p-6">
        {/* Mobile header */}
        <div className="mb-4 flex items-center gap-3 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[color:var(--operator-muted)] hover:bg-[color:var(--operator-surface-soft)]"
            aria-label="Open settings menu"
          >
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold text-[color:var(--operator-foreground)]">Settings</span>
        </div>
        {children}
      </main>
    </div>
  );
}
