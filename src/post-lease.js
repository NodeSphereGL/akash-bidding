// Atomic post-lease block: insert the deployment audit row AND lock the next
// available group in a single mysql transaction. Either both succeed or
// neither does — guarantees no orphan locked groups when insert fails.
//
// The Akash PUT (SDL update with GROUP_NAME injected) happens OUTSIDE the tx,
// because it's an external HTTP call and shouldn't hold a row lock.

import { withTx as defaultWithTx } from "./db/pool.js";
import { NoGroupAvailableError } from "./errors.js";

/**
 * @param {object} args
 * @param {{ deploymentsRepo: object, groupsRepo: object }} args.db
 * @param {string} args.dseq
 * @param {{ id: number, name: string, workspace?: string }} args.account
 * @param {{ bid?: { provider?: string, uactPerBlock?: number } }} args.leaseResult
 * @param {number} args.hours - lock duration (config.GROUP_LOCK_HOURS)
 * @param {Date}   args.now
 * @param {Date}   args.expiresAt
 * @returns {Promise<{ group: object|null }>}
 * @throws {NoGroupAvailableError} if no AVAILABLE group in this workspace
 * @throws {DbError}               if insert or lock fails (lease is now orphaned on-chain)
 */
export async function postLeaseAtomic({ db, dseq, account, leaseResult, hours, now, expiresAt, withTx = defaultWithTx }) {
  return await withTx(async (conn) => {
    await db.deploymentsRepo.insert(
      {
        dseq,
        accountId: account.id,
        provider: leaseResult.bid?.provider ?? null,
        uactPerBlock: leaseResult.bid?.uactPerBlock ?? null,
        status: "LEASED",
        leasedAt: now,
        expiresAt,
      },
      conn,
    );
    const group = await db.groupsRepo.lockNextAvailable(
      account.id,
      dseq,
      hours,
      account.workspace,
      conn,
    );
    if (!group) {
      throw new NoGroupAvailableError(account.workspace ?? "DEFAULT");
    }
    return { group };
  });
}
