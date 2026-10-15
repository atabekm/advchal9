# Members and invitations

## Roles

| role | can |
| --- | --- |
| owner | everything, including billing, security settings and deleting the organization; one per organization |
| admin | manage members, projects, integrations and API keys |
| member | work in the projects they belong to |
| guest | see and comment on the projects they're invited to; free, don't use a seat |

Billing admin is a separate permission an owner can give to any member.

## Invitations

Admins invite people in **Admin › Members › Invite** by email. The invitee gets an email with a
link to create their account. Each invitation needs a free seat.

- An invitation is valid for **7 days**. After that the link shows "This invitation has expired"
  (`INVITE_EXPIRED`) and can't be used to sign up or sign in.
- An admin can **resend** it in **Admin › Members › Pending › Resend**; the new link is valid
  for another 7 days and the old one stops working.
- If the organization requires SSO, the invitee signs in with SSO instead of creating a
  password; the invitation still has to be accepted first.
- An invitee can't ask support to activate the account: only the organization's admins can
  invite or resend.

## Deactivating members

**Admin › Members › … › Deactivate** frees the seat. The member can't sign in
(`AUTH_403_DEACTIVATED`), their tasks stay, and **API keys they created are revoked**.
Reactivate them from the same menu (needs a free seat); revoked keys stay revoked.

## Unlocking a member

When a member is locked after too many sign-in attempts, an admin can click **Unlock** next to
their name in **Admin › Members**.

## Changing your email

**Profile › Account › Email**. We send a confirmation link to the new address. In an
organization that requires SSO the email comes from the identity provider and can't be changed
in Flowdesk.
