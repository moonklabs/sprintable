import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { LoopsRouteProvider } from './loops-context';

interface LoopsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ ws: string; proj: string }>;
}

/**
 * story a539c649(S-route-project) S3a — Server Component 경계(docs/S2·retro/S3a와 동일 패턴).
 * proxy.ts(S1)가 resolve 성공 시 forwarded request 헤더에 실어 보낸 x-resolved-project-id 를
 * 여기서 읽어 client 트리(page.tsx + [id]/page.tsx 둘 다)에 context 로 전달한다.
 */
export default async function LoopsLayout({ children, params }: LoopsLayoutProps) {
  const { ws, proj } = await params;
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return (
    <LoopsRouteProvider wsSlug={ws} projSlug={proj} projectId={projectId}>
      {children}
    </LoopsRouteProvider>
  );
}
