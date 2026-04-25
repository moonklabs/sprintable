'use client';

import { useEffect, type ReactNode } from 'react';
import { useTopBar } from './top-bar-context';

interface TopBarSlotProps {
  title: ReactNode;
  actions?: ReactNode;
}

export function TopBarSlot({ title, actions = null }: TopBarSlotProps) {
  const { setSlot, clearSlot } = useTopBar();
  useEffect(() => {
    setSlot({ title, actions });
    return clearSlot;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, actions]);
  return null;
}
