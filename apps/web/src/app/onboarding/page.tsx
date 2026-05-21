import { OnboardingForm } from './onboarding-form';

interface OnboardingPageProps {
  searchParams: Promise<{ step?: string; orgId?: string }>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  const initialStep = params.step === 'project' ? 'project' : undefined;
  const initialOrgId = params.orgId ?? undefined;

  return <OnboardingForm initialStep={initialStep} initialOrgId={initialOrgId} />;
}
