'use client';

// story 4891 (UI-8 · settings › notifications · PO 11-10): the pane that was inline in page.tsx, rebuilt on the ds parts so a phone can use it —
// every press ≥ 44 px (ds Button on a touch screen · the switch is a 44 px target around its 24 px track), no text under 12 px, a heading per category
// (SectionHeader) with its rows as ds ListRow (56 px), the webhook / e-mail «soon» columns only where there is room (a desktop width).
// What it shows and what each press does is the page's own (handlers come in as props) — nothing here saves anything.
import { useTranslations } from 'next-intl';
import { PushRegisterNotice } from '@/components/settings/push-register-notice';
import { Button } from '@/components/ds/button';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { SettingsSection } from '@/components/settings/settings-section';
import { cn } from '@/lib/utils';

export type NotificationLevel = 'all' | 'mentions' | 'mute';

export interface NotificationsPaneProps {
  loading: boolean;
  categories: ReadonlyArray<{ readonly key: string; readonly types: ReadonlyArray<string> }>;
  globalLevel: NotificationLevel;
  savingLevel: boolean;
  onSetLevel: (level: NotificationLevel) => void;
  getEnabled: (eventType: string) => boolean;
  onToggle: (eventType: string, currentEnabled: boolean) => void;
  isCategoryAllEnabled: (categoryKey: string) => boolean;
  onToggleCategory: (categoryKey: string, enable: boolean) => void;
  /** EE builds draw the two «coming soon» channel columns (desktop widths only) */
  showSoonColumns: boolean;
}

/** one of the three default levels — a press that picks it (aria-pressed says which is picked) */
function LevelButton({ level, current, disabled, onSetLevel }: { level: NotificationLevel; current: NotificationLevel; disabled: boolean; onSetLevel: (level: NotificationLevel) => void }) {
  const t = useTranslations('settings');
  return (
    <Button type="button" variant={current === level ? 'primary' : 'secondary'} disabled={disabled} onClick={() => onSetLevel(level)} aria-pressed={current === level}>
      {t(`notificationLevel_${level}`)}
    </Button>
  );
}

export function NotificationsPane({ loading, categories, globalLevel, savingLevel, onSetLevel, getEnabled, onToggle, isCategoryAllEnabled, onToggleCategory, showSoonColumns }: NotificationsPaneProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  return (
    <SettingsSection title={t('notifications')} description={t('notificationDescription')}>
        {/* story #4694 AC2 ② — the phone's «could not register for notifications» line (phone app only · nothing when fine) */}
        <PushRegisterNotice />
        {loading ? (
          <div className="space-y-3" data-testid="notifications-pane-loading">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : (
          <div className="space-y-4" data-testid="notifications-pane">
            {/* story #2272 — the default level: one of three */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-ds-control border border-ds-line bg-ds-surface px-3 py-2" data-testid="notifications-default-level">
              <span className="text-ds-body text-ds-ink">{t('notificationDefaultLevel')}</span>
              <div className="flex shrink-0 gap-1">
                <LevelButton level="all" current={globalLevel} disabled={savingLevel} onSetLevel={onSetLevel} />
                <LevelButton level="mentions" current={globalLevel} disabled={savingLevel} onSetLevel={onSetLevel} />
                <LevelButton level="mute" current={globalLevel} disabled={savingLevel} onSetLevel={onSetLevel} />
              </div>
            </div>

            {/* the column heads: «앱 내» is the one every row has (the switches' names read it: aria-labelledby); webhook / e-mail are the «soon» ones — a desktop width only */}
            <div className="flex items-center justify-end gap-2 px-4 text-center text-ds-small font-semibold text-ds-ink-3">
              <span id="notif-col-in-app" className="w-14">{t('notification_channel_in_app')}</span>
              {showSoonColumns ? <span className="hidden w-14 opacity-60 lg:block">{t('notification_channel_webhook')}</span> : null}
              {showSoonColumns ? <span className="hidden w-14 opacity-60 lg:block">{t('notification_channel_email')}</span> : null}
            </div>

            {categories.map((category) => {
              const allEnabled = isCategoryAllEnabled(category.key);
              return (
                <section key={category.key} className="overflow-hidden rounded-ds-control border border-ds-line" data-testid={`notifications-category-${category.key}`}>
                  <SectionHeader
                    title={t(`notification_category_${category.key}`)}
                    level={3}
                    trailing={
                      <Button
                        type="button"
                        variant="quiet"
                        // «Disable all» ×4 would read the same four times: the name carries the category it acts on (§22-18)
                        aria-label={t('notificationCategoryToggleAria', { category: t(`notification_category_${category.key}`), action: allEnabled ? tc('disable_all') : tc('enable_all') })}
                        onClick={() => onToggleCategory(category.key, !allEnabled)}
                      >
                        {allEnabled ? tc('disable_all') : tc('enable_all')}
                      </Button>
                    }
                  />
                  {category.types.map((eventType) => {
                    const enabled = getEnabled(eventType);
                    return (
                      <ListRow
                        key={eventType}
                        title={<span id={`notif-event-${eventType}`}>{t(`event_${eventType}`)}</span>}
                        trailing={
                          <>
                            {/* [SID:4379] a switch: «(event) 앱 내, switch, on» — name = the row's event + the column head */}
                            <Button
                              type="button"
                              variant="quiet"
                              role="switch"
                              aria-checked={enabled}
                              aria-labelledby={`notif-event-${eventType} notif-col-in-app`}
                              // the labelledby pair is the name read («event 앱 내»); this one says the same event for the row-action scan and for a tool that reads aria-label only (§22-18)
                              aria-label={t(`event_${eventType}`)}
                              onClick={() => onToggle(eventType, enabled)}
                              className="h-11 w-14 border-transparent p-0"
                            >
                              <span className={cn('relative h-6 w-11 rounded-full border transition', enabled ? 'border-ds-action bg-ds-action' : 'border-ds-line-control bg-ds-surface-high')}>
                                <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]', enabled ? 'left-[22px]' : 'left-0.5')} />
                              </span>
                            </Button>
                            {showSoonColumns ? <span className="hidden w-14 text-center text-ds-small text-ds-ink-3 opacity-60 lg:block">{t('notification_coming_soon')}</span> : null}
                            {showSoonColumns ? <span className="hidden w-14 text-center text-ds-small text-ds-ink-3 opacity-60 lg:block">{t('notification_coming_soon')}</span> : null}
                          </>
                        }
                      />
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
    </SettingsSection>
  );
}
