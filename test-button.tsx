import { Button } from './apps/web/src/components/ui/button';
import Link from 'next/link';

export function Test() {
  return <Button nativeButton={false} render={<Link href="/" />}>Test</Button>;
}
