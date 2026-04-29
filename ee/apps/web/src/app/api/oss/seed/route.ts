import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({ error: 'Not available in SaaS mode' }, { status: 501 });
}
