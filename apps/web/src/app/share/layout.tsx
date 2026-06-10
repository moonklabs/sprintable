import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Public share pages must never be indexed (b1574f5a · B-4).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Minimal public shell for shared docs — no app sidebar/nav, no edit affordances.
 * Theme + i18n providers come from the root layout; this group sits outside
 * (authenticated) so no login is required.
 */
export default function ShareLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="flex-shrink-0 border-b border-border/60 px-4 py-3 lg:px-8">
        <span className="text-sm font-semibold tracking-tight text-muted-foreground">Sprintable</span>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
