'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { resolveAppUrl } from '@/services/app-url'

export async function signInWithOAuth(provider: 'google' | 'github', formData: FormData) {
  const returnTo = formData.get('returnTo') as string | null
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()

  const origin = resolveAppUrl(null)
  const redirectTo = returnTo && returnTo.startsWith('/')
    ? `${origin}/auth/callback?next=${encodeURIComponent(returnTo)}`
    : `${origin}/auth/callback`

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  })

  if (error || !data.url) {
    redirect('/login?error=oauth_init_failed')
  }

  redirect(data.url)
}
