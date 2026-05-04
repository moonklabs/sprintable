import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';

export default async function RootPage() {
  const session = await getServerSession();
  redirect(session ? '/inbox' : '/login');
}
