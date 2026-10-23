"""[SID:4753] The organization row is the one lock every write that CREATES or ACTIVATES an organization's subscription takes, and the same one the closing paths take.

The closing paths — the owner's organization delete (`OrganizationRepository.delete_by_user`) and the account deletion's «closes with it» (`delete_for_account_closure`) — lock the
`organizations` row first, look at the subscription (`_has_active_or_in_flight_subscription`), and delete the row. The checkout claim (`org_subscription_checkout.claim_checkout_slot`) already
took the same lock. The payment provider's webhook and the admin grant did not: a subscription written between the closing's look and its commit (or after it) landed on an organization that
was going or gone — `org_subscriptions` has no foreign key to `organizations`, so nothing refused it. One order everywhere: organization row first, then whatever else the write touches.

`lock_org_for_billing_write` locks the row until the caller's commit / rollback and says whether the organization still exists. «Closed» is «the row is gone» — both closing paths end with
deleting it — so a False answer means: do not write a subscription for this organization."""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def lock_org_for_billing_write(session: AsyncSession, org_id: uuid.UUID) -> bool:
    row = await session.execute(text("SELECT 1 FROM organizations WHERE id = :o FOR UPDATE"), {"o": str(org_id)})
    return row.first() is not None
