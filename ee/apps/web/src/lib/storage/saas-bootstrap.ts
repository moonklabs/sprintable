/**
 * SaaS Repository bootstrap.
 *
 * Call `registerSaasRepositories()` once at app startup (Next.js
 * instrumentation hook or root layout import side-effect) to override
 * the OSS-default Null stubs with real Supabase-backed implementations.
 *
 * OSS code (sprintable-core) never imports @moonklabs/storage-saas
 * directly — this file (which lives in the SaaS overlay) is the only
 * link between the public factory registry and the private SaaS impls.
 */
import {
  registerSubscriptionRepository,
  registerAgentRunBillingRepository,
} from '@/lib/storage/factory';
import {
  SupabaseSubscriptionRepository,
  SupabaseAgentRunBillingRepository,
} from '@moonklabs/storage-saas';
import type { SupabaseClient } from '@supabase/supabase-js';

let _bootstrapped = false;

async function getSpAt(): Promise<string> {
  try {
    const { cookies } = await import('next/headers');
    const store = await cookies();
    return store.get('sp_at')?.value ?? '';
  } catch { return ''; }
}

export function registerSaasRepositories(): void {
  if (_bootstrapped) return;
  _bootstrapped = true;

  registerSubscriptionRepository(async (supabase?: unknown) => {
    return new SupabaseSubscriptionRepository(supabase as SupabaseClient, await getSpAt());
  });

  registerAgentRunBillingRepository(async (supabase?: unknown) => {
    return new SupabaseAgentRunBillingRepository(supabase as SupabaseClient, await getSpAt());
  });
}
