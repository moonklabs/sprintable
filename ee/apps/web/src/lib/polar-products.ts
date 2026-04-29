export interface PolarProduct {
  teamMonthly: string;
  teamYearly: string;
  proMonthly: string;
  proYearly: string;
}

const SANDBOX: PolarProduct = {
  teamMonthly: '200c2c3c-1235-41e1-a259-1440200b4a93',
  teamYearly: 'e79b7587-6261-4384-abdb-f3fd13612f06',
  proMonthly: '9e3c0067-7d28-4314-abe8-c59929eedf30',
  proYearly: '39462386-91b7-4864-9cc2-eecc8cfc2307',
};

export const POLAR_PRODUCTS: PolarProduct = {
  teamMonthly: process.env['NEXT_PUBLIC_POLAR_PRODUCT_TEAM_MONTHLY'] ?? SANDBOX.teamMonthly,
  teamYearly: process.env['NEXT_PUBLIC_POLAR_PRODUCT_TEAM_YEARLY'] ?? SANDBOX.teamYearly,
  proMonthly: process.env['NEXT_PUBLIC_POLAR_PRODUCT_PRO_MONTHLY'] ?? SANDBOX.proMonthly,
  proYearly: process.env['NEXT_PUBLIC_POLAR_PRODUCT_PRO_YEARLY'] ?? SANDBOX.proYearly,
};

export const POLAR_PRODUCT_TIER: Record<string, string> = {
  [POLAR_PRODUCTS.teamMonthly]: 'team',
  [POLAR_PRODUCTS.teamYearly]: 'team',
  [POLAR_PRODUCTS.proMonthly]: 'pro',
  [POLAR_PRODUCTS.proYearly]: 'pro',
};

export const POLAR_PRODUCT_BILLING_CYCLE: Record<string, string> = {
  [POLAR_PRODUCTS.teamMonthly]: 'monthly',
  [POLAR_PRODUCTS.teamYearly]: 'yearly',
  [POLAR_PRODUCTS.proMonthly]: 'monthly',
  [POLAR_PRODUCTS.proYearly]: 'yearly',
};
