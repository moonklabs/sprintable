import { NextResponse } from 'next/server';
import { resolveAppUrl } from '@/services/app-url';

export async function GET(_request: Request) {
  const origin = resolveAppUrl(null);
  return NextResponse.redirect(`${origin}/login`);
}
