'use client';

// story #4443 PR3b — the zone a team's promised times are set and read in: the org's (organizations.timezone · #3422 — content
// schedules, ad windows, newsletter sends), the viewer's when the org has set none. Drawn with formatScheduledAt(iso, teamTz,
// viewerTz): labelled («… GMT+9») only when that offset is not the viewer's (Yuna 03:27Z).
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { validTimeZone } from '@/lib/viewer-time-zone';

export function useTeamTimeZone(): string | null {
  const { orgTimezone } = useDashboardContext();
  const viewerTz = useViewerTimeZone();
  return validTimeZone(orgTimezone) ?? viewerTz;
}
