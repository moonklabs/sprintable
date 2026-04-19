import * as React from 'react';
import { Button } from '@/components/ui/button';

export function OperatorIconButton(props: React.ComponentProps<typeof Button>) {
  return <Button variant="outline" size="icon" className="rounded-md text-muted-foreground hover:text-foreground" {...props} />;
}
