'use client';

import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const t = useTranslations('common');

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  return (
    <Button variant="destructive" className="w-full" onClick={handleLogout}>
      {t('logout')}
    </Button>
  );
}
