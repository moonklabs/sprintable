import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { OnboardingForm } from './onboarding-form';

export default async function OnboardingPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // 기존 멤버십 체크 — 이미 조직 소속이면 /dashboard
  const { data: memberships } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1);

  if (memberships && memberships.length > 0) {
    redirect('/dashboard');
  }

  return <OnboardingForm />;
}
