import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return <PageSkeleton showTitle cards={3} rows={4} />;
}
