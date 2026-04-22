'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function UpgradeSuccessPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <div className="mb-6 text-5xl">🎉</div>
      <h1 className="font-heading text-2xl font-bold">업그레이드 완료!</h1>
      <p className="mt-3 text-muted-foreground">
        구독이 성공적으로 시작되었습니다. 이제 모든 기능을 사용할 수 있습니다.
      </p>
      <Button asChild className="mt-8">
        <Link href="/">대시보드로 이동</Link>
      </Button>
    </div>
  );
}
