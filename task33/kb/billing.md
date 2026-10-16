# Plans and billing

## Plans

| plan | price | for |
| --- | --- | --- |
| Free | 0 | up to 5 members, 3 projects, 10 MB attachments |
| Team | 8 USD per member per month | unlimited projects, integrations, 100 MB attachments |
| Business | 14 USD per member per month | Team + SSO, required 2FA, audit log, full workspace export |
| Enterprise | custom | Business + SCIM, data region choice, 99.9% SLA, a named account manager |

Yearly billing is 2 months cheaper. Prices are without VAT.

## Seats

You pay for seats, not for active users. An owner or billing admin adds seats in
**Admin › Billing › Seats › Add seats**; new seats are charged pro rata for the rest of the
billing period. Removing seats takes effect at the next renewal. Inviting someone needs a free
seat.

## Who can manage billing

The organization's **owner** and anyone they make a **billing admin**. Only they see invoices,
change the plan or payment method. Other members can see who the billing admins are in
**Admin › Members**.

## Unpaid invoices

If a payment fails, the subscription becomes **past due** and the owner and billing admins are
emailed. Flowdesk retries the card on days 3, 7 and 14.

- During the first **14 days** past due, everything keeps working.
- After 14 days the workspace is **suspended**: members can't sign in and get
  `AUTH_402_ORG_SUSPENDED` ("Your organization's workspace is suspended"). Integrations and the
  API stop too.
- Owners and billing admins can still sign in, but only to **Admin › Billing**, where they can
  pay the open invoice or change the card. Access returns for everyone within a few minutes of a
  successful payment.
- Data of a suspended workspace is kept for **90 days**, then deleted.

Members can't pay on behalf of the organization; they need to contact their owner or billing
admin.

## Invoices and receipts

Invoices are emailed to the billing email and listed in **Admin › Billing › Invoices**. To add a
VAT number or change the company address, edit **Billing details**; it applies to future
invoices.

## Cancelling

Cancel in **Admin › Billing › Plan › Cancel subscription**. The plan stays active until the end
of the paid period, then the organization moves to Free. Projects over the Free limits become
read-only.
