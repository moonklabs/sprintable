import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { RetroRouteProvider } from './retro-context';

interface RetroLayoutProps {
  children: React.ReactNode;
  params: Promise<{ ws: string; proj: string }>;
}

/**
 * story a539c649(S-route-project) S3a — Server Component 경계(docs/S2와 동일 패턴). proxy.ts
 * (S1)가 resolve 성공 시 forwarded request 헤더에 실어 보낸 x-resolved-project-id 를 여기서
 * 읽어 client 트리(page.tsx + [id]/page.tsx 둘 다)에 context 로 전달한다 — layout→page 는
 * children 만 흐르고 custom prop 은 못 흘러서 context 가 필요(docs-context.tsx 와 동형 이유).
 */
export default async function RetroLayout({ children, params }: RetroLayoutProps) {
  const { ws, proj } = await params;
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return (
    <RetroRouteProvider wsSlug={ws} projSlug={proj} projectId={projectId}>
      {children}
    </RetroRouteProvider>
  );
}
