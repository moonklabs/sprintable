import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';

export default async function RootPage() {
  if (isOssMode()) {
    redirect('/inbox');
  }

  const supabase = (undefined as any);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? '/inbox' : '/login');
}
