import { NextResponse } from 'next/server';
import { createDocRepository } from '@/lib/storage/factory';

export const dynamic = 'force-dynamic';

const PROJECT_ID = 'f3e6ed64-447d-4b1c-ad78-a00cfba715a7';
const DOC_SLUG = 'baos-enrollment-guide-agent';

export async function GET() {
  try {
    const db = undefined;
    const repo = await createDocRepository(db);
    const doc = await repo.getBySlug(PROJECT_ID, DOC_SLUG);

    if (!doc) {
      return new NextResponse('Not Found', { status: 404 });
    }

    return new NextResponse(doc.content ?? '', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
