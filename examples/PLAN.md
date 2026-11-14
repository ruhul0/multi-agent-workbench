# Orders feature

Customers need to see their past orders.

- Backend: `GET /api/orders` with cursor pagination (20 per page), newest first.
  Only the signed-in customer's orders. Add tests.
- Frontend: an Orders page that lists orders, loads more on scroll, and shows an
  empty state. Use the existing API client.
- QA: merge both branches, run the full test suite, and fix only clear bugs.

Out of scope: refunds, order editing.
