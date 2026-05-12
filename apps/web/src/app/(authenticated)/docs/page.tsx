import { redirect } from 'next/navigation';
import { DocsEmptyView } from './docs-empty-view';

export default async function DocsPage({ searchParams }: { searchParams: Promise<{ slug?: string }> }) {
  const { slug } = await searchParams;
  if (slug) redirect(`/docs/${slug}`);
  return <DocsEmptyView />;
}
