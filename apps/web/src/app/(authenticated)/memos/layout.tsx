import type { ReactNode } from 'react';
import { MemosLayoutClient } from './memo-layout-client';

export default function MemosLayout({ children }: { children: ReactNode }) {
  return <MemosLayoutClient>{children}</MemosLayoutClient>;
}
