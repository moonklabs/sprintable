import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { getServerSession } from '@/lib/db/server';

export default async function RootPage() {
  if (isOssMode()) {
    redirect('/inbox');
  }

  const session = await getServerSession();
  redirect(session ? '/inbox' : '/login');
}
