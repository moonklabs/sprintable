export function isEEEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EE_ENABLED === 'true';
}
