// OSS stub — 실제 사용량 대시보드는 @moonklabs/sprintable-saas 에 있다.
// OSS 단독 빌드에서는 "usage tracking is disabled" 안내만 표시.
'use client';

export interface UsageDashboardProps {
  orgId?: string;
  currentProjectId?: string | null;
  projects?: Array<{ id: string; name: string }>;
  defaultMonth?: string;
  projectId?: string | null;
}

export function UsageDashboard(_props: UsageDashboardProps) {
  return (
    <div className="p-6 text-muted-foreground">
      Usage tracking is disabled in OSS mode.
    </div>
  );
}
