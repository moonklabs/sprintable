import * as React from 'react';
import { Button } from '@/components/ui/button';

export function OperatorIconButton(props: React.ComponentProps<typeof Button>) {
  return <Button variant="glass" size="icon" className="rounded-2xl border-white/8 text-[color:var(--operator-muted)] hover:text-[color:var(--operator-foreground)]" {...props} />;
}
