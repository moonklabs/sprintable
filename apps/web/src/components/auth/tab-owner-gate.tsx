'use client';

import { useState, type ReactNode } from 'react';
import { claimTabOwner } from '@/lib/tab-owner';

/**
 * story #4490 — renders the signed-in screen only after this browser's values are known to be `userId`'s: the check runs in
 * the first render (a state initializer), so it finishes before any child renders or runs an effect (React runs a child's
 * effect before its parent's — an effect here would let a child read the previous person's value once · PO 05:00Z ①).
 * Every layout that reads the session renders this (browser-storage-keys … tab-owner-gate.guard.test.ts keeps it so).
 */
export function TabOwnerGate({ userId, children }: { userId: string | null | undefined; children: ReactNode }) {
  useState(() => {
    if (userId) claimTabOwner(userId);
    return null;
  });
  return <>{children}</>;
}
