# Drinks and accessories desk

Staff tools are available at `/retail.html`: Inventory, POS and Manager. This module is a separate drinks/accessories inventory. It does not read or modify the existing member menu. Quantities are whole packaged items; custom unit labels (can, bottle, pack) are descriptive and do not enable fractional or weight-based sales. Product filter labels are user-defined.

## Setup and use

Open Manager, unlock, and add staff attribution profiles. The existing master admin password (`ADMIN_PASS`) works by default. Optionally configure `RETAIL_MASTER_PASSWORD_HASH` (bcrypt) or `RETAIL_MASTER_PASSWORD` separately; neither is exposed to the client. Unlocks expire after 15 minutes and are tied to the current staff session. A profile's manager role is a reporting label, not a permission grant. All tools still require server-verified staff authentication.

Create inventory products and set euro price per packaged item; stock starts at zero. Use an explicit stock adjustment with a reason to receive a delivery, record damage, or reconcile counts. Archive through product details, preserving history. POS only offers active products and cannot sell more than available stock.

Choose a staff profile to start/resume its single open shift. Add products and complete a cash sale. Tips are separate cash entries on the selected shift. The shift view lists receipts with unique IDs and lets staff correct quantities, replace items, or void a sale. Original lines preserve original sale prices. The result says how much cash to refund or collect. Closed shifts need a manager unlock for corrections. Close shifts after completing or clearing the basket.

## Accounting and privacy

MongoDB transactions commit sales, stock movements, revision history, shift updates and idempotency receipts together. Retry keys are bound to the authenticated actor, route and request contents. Stock never goes negative, money is integer cents, and quantities/products/totals must fit JavaScript safe integers. Concurrent final-unit sales and stale edits are rejected. Ledger entries retain authenticated actor IDs as well as sales' selected staff profiles.

Reports use Europe/Madrid dates, including DST. Presets cover today, Monday-to-today, and month-to-date; custom ranges allow up to one year. Corrections restate the original sale date and its staff attribution rather than creating a new sale. Tips are summed by entry date. Staff totals include role, sales, receipts, tip amount and tip-entry count. Product rankings show units/revenue; daily totals show trends. Shift drill-down shows lifetime shift totals even when a shift crosses the selected report boundary. This is a cash operational ledger, not fiscal invoicing or tax software.

Reports are no-store and unlocked only in memory; raw master passwords and access tokens are not stored in analytics or audit records. Staff profile selection is attribution on a shared staff-authorized terminal, not proof of which employee physically operated it. Production fixtures are never created by automated tests.

## Validation

`npm test` includes retail authorization, session-bound manager unlocks, money/unit validation, daylight-saving date boundaries, duplicate sale retries, concurrent final-unit sales, stock correction rollback, stale revisions, voids, price preservation, closed-shift access, and tip attribution. The frontend DOM test in its repository exercises labels, profile selection, retry-safe checkout, tips and report locking with synthetic data.
