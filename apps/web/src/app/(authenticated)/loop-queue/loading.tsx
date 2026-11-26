import { PageSkeleton } from '@/components/ui/page-skeleton';

// story 5031 (C1) — «지금 개입할 것» (/loop-queue) became a menu destination (a ⌘K door and a row in «전체»): like every destination it has a loading screen that says it is loading.
export default function Loading() {
  return <PageSkeleton />;
}
