import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export default async function RootPage() {
  if (isOssMode()) {
    redirect('/inbox');
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? '/inbox' : '/login');
}
