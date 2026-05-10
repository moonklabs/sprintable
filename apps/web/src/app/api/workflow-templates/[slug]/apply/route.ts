import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return proxyToFastapi(request, `/api/v2/workflow-templates/${slug}/apply`);
}
