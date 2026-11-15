// 4913 — the ONE empty shape of the «데스크톱 앱» screen: a dashed ds Card with a title and an optional line (the «연결된 기기» empty state was this; «원격 기기» was bare text — two shapes on one screen).
import type { ReactNode } from 'react';
import { Card } from '@/components/ds/card';

export function DesktopEmptyState({ title, children, testId }: { title: string; children?: ReactNode; testId: string }) {
  return (
    <Card className="border-dashed px-4 py-5" data-testid={testId}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? <p className="text-xs text-muted-foreground">{children}</p> : null}
    </Card>
  );
}
