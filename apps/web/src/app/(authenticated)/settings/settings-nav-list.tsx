'use client';

// story 4891 (UI-8 AC4 · first screen rebuild) — the settings list drawn with the ds parts: a SectionHeader per group (12px+ — the old headings were 10px) and a ListRow per section (min height 56 · name + › on a phone ·
// selected = aria-current). Which sections exist is `settingsNavGroups` (settings-nav.ts) — this file only draws what it is given. The rows are the Tabs primitive's own `Tab`s inside its `List` (inside the page's Tabs root),
// so the roving focus, arrow keys, aria-selected and the tab ↔ panel association are the primitive's — the same as the old TabsTrigger had.
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ds/icon';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { cn } from '@/lib/utils';
import type { SettingsNavGroup, SettingsNavItem } from './settings-nav';

interface SettingsNavProps {
  groups: SettingsNavGroup[];
  /** the selected section — marks its row (the Tabs root the list sits in owns the selection and its change handler) */
  activeTab: string;
  /** where the «연동» link goes (the page adds the project / flat-path rule) */
  integrationsHref: string;
  /** story 5037: where a link row that names a nav-catalog screen (`navId`) goes (the page reads the catalog and adds the project / flat-path rule) — null = the catalog has no such screen: the row is not drawn */
  hrefFor: (navId: string) => string | null;
}

// story 5031 (C1 step 5c · PO): from lg the section rows are 40 high (the kit's control height — they were the list's 56 with a 224 column); below lg they stay 56 (a phone's whole-screen list, as before). The sides stay 16 (`px-4` of the row).
const LG_ROW = 'lg:min-h-ds-control lg:py-ds-1';

function SettingsNavSkeleton() {
  return (
    <div className="flex h-14 items-center gap-3 border-b border-ds-line px-4" data-testid="settings-tab-skeleton" aria-hidden="true">
      <div className="size-ds-icon-sm animate-pulse rounded bg-ds-surface-high" />
      <div className="h-3 w-24 animate-pulse rounded bg-ds-surface-high" />
    </div>
  );
}

export function SettingsNav({ groups, activeTab, integrationsHref, hrefFor }: SettingsNavProps) {
  const t = useTranslations('settings');
  const tNav = useTranslations('nav');
  const row = (item: SettingsNavItem) => {
    const href = item.kind === 'link' ? (item.navId ? hrefFor(item.navId) : integrationsHref) : null;
    if (item.kind === 'link' && href === null) return null;
    const active = item.kind === 'tab' && item.id === activeTab;
    const inner = (
      <>
        <Icon name={item.icon} size="sm" className={item.danger ? 'text-ds-failed' : 'text-ds-ink-2'} />
        <span className={cn('min-w-0 flex-1 truncate text-ds-body font-semibold', item.danger ? 'text-ds-failed' : 'text-ds-ink')}>{item.ns === 'nav' ? tNav(item.labelKey) : t(item.labelKey)}</span>
        <Icon name="chevron_right" className="text-ds-ink-3 lg:hidden" />
      </>
    );
    return item.kind === 'link' ? (
      <ListRow key={item.id} asChild className={LG_ROW}>
        <Link href={href!} className="w-full" data-settings-link={item.id}>{inner}</Link>
      </ListRow>
    ) : (
      // below lg the list is only ever shown INSTEAD of a pane (the whole screen), so a tinted «selected» row there points at nothing — the tint is for the side-by-side layout (≥lg); `aria-current` stays at every width
      <ListRow key={item.id} asChild selected={active} className={cn('max-lg:bg-transparent', LG_ROW)}>
        <TabsPrimitive.Tab value={item.id} data-settings-tab={item.id} className="w-full">{inner}</TabsPrimitive.Tab>
      </ListRow>
    );
  };
  return (
    <TabsPrimitive.List className="flex w-full flex-col" data-testid="settings-nav">
      {groups.map((group) => {
        return (
          <section key={group.id} data-group={group.id}>
            <SectionHeader level={2} title={t(group.labelKey)} />
            {group.items.map(row)}
            {Array.from({ length: group.pending }, (_, i) => <SettingsNavSkeleton key={`pending-${i}`} />)}
          </section>
        );
      })}
    </TabsPrimitive.List>
  );
}
