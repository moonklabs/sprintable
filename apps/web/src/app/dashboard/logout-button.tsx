'use client';

import { useRouter } from 'next/navigation';
import { logoutUser } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  const router = useRouter();
  const t = useTranslations('common');

  const handleLogout = async () => {
    await logoutUser();
    router.push('/login');
    router.refresh();
  };

  return (
    <Button variant="destructive" size="sm" onClick={handleLogout}>
      {t('logout')}
    </Button>
  );
}
