import React from 'react';
import Link from 'next/link';
import { Button } from './apps/web/src/components/ui/button';

export default function Test() {
  return (
    <Button nativeButton={false} render={<Link href="/" />}>
      <span>Test</span>
    </Button>
  );
}
