# Staff access review — 19 September 2026

Scope: admin.html and registration-desk.html (including clean URL variants), all seven admin tools, linked API handlers, and repository HTML route inventory. Static page markup contains UI only; Railway authorization protects data and mutations. A frontend redirect is not a replacement for backend checks.

| Tool | API protection reviewed |
| --- | --- |
| Menu | Authenticated reads; staff-only create, update, delete and shelve |
| Members / credits | Staff-only list and updates/deletion; password excluded from lists |
| Events | Public event read intentionally retained; master-admin-only writes |
| Content / posts | Authenticated post reads; master-admin-only content and write operations |
| Registration | Staff middleware on all desk data, images, numbering and activation; owner-only number/template setup. Public prefill/upload capability endpoints remain deliberately public with their existing validation. |
| Passkeys | Master-admin-only list/register/delete; login challenge/verification endpoints intentionally public |
| Dashboard / admin accounts | Staff-only stats/activity; master/super-admin-only account management |

Changes: both staff pages hide controls until server session verification and redirect missing/invalid credentials. JWT expiry hides unattended UI; other-tab logout and browser-back restores recheck. APIs reject malformed Bearer headers, expired/invalid tokens and enforce HS256; authenticated responses are no-store. DB staff roles are checked against current account records on each request, so deletion/demotion invalidates old privileges. Master login requires a nonempty string password and configured master secret; object-valued emails rejected. Removed unsafe inline interpolation of staff names in passkey delete actions.

UI fixes: prevent action clicks bubbling into detail modals; raise detail modal above list; separate list/editor views for menu, members, events and passkeys; reset Add handler when switching from an edit to New; touch-sized controls and constrained viewport with one content scroll area.

Validation: isolated JWT middleware tests cover missing/invalid/expired/member access, revocation and role downgrades. Existing registration integration suite covers staff gates and private-image access. Synthetic DOM checks cover page locking, validation, edit/list transitions and New-after-Edit. No production staff credentials or live record mutations were used. This is a scoped review, not a penetration-test certification; signed-out static HTML/JS remains downloadable by design. Master/passkey-issued JWTs expire after one hour; logging out clears the browser token rather than globally revoking a copied token.
