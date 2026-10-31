/**
 * Host half of the composer cost bundle.
 *
 * Both cells are Client work: the session cell reads the Session's own
 * `tokenUsage` projection, and the daily cell reads the ledger the sibling
 * package `@local/composer-cost-day` accumulates. This module exists only so the
 * package is a valid Loader row.
 */
export function apply() {}
