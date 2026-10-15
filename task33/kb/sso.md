# Single sign-on (SSO)

Available on the **Business** and **Enterprise** plans. Flowdesk supports SAML 2.0 with Okta,
Microsoft Entra ID (Azure AD), Google Workspace and OneLogin.

## Setting up SSO

An owner opens **Admin › Security › Single sign-on**, adds the identity provider's metadata URL
and verifies the email domain (for example `acme.com`) with a DNS TXT record. Users are created
on first sign-in if "Just-in-time provisioning" is on. Enterprise plans also support SCIM.

## Require SSO

With **Require SSO** on, members of the organization can only sign in through the identity
provider:

- the email and password form rejects them with `AUTH_403_SSO_REQUIRED` ("Your organization
  requires single sign-on");
- **Sign in with Google** is disabled for them;
- password reset emails no longer contain a reset link;
- owners can still sign in with a password, so a broken SSO configuration never locks everyone
  out.

When an admin turns it on, existing sessions stay valid until they expire; the change shows up
the next time someone signs in.

## Signing in with SSO

On the sign-in page click **Sign in with SSO**, enter your work email (or the organization's
workspace name), and you are sent to your company's identity provider. After signing in there
you come back to Flowdesk.

If the identity provider says you are not assigned to the application, ask your IT team to
assign you to the Flowdesk app in Okta, Entra ID or Google Workspace. Flowdesk support cannot
change assignments in your identity provider.

## Troubleshooting SSO

- `SSO_NOT_ASSIGNED`: you are not assigned to Flowdesk in the identity provider; contact your IT.
- `SSO_SIGNATURE_INVALID`: the identity provider's certificate changed; an owner has to upload
  the new metadata.
- A loop between Flowdesk and the identity provider usually means third-party cookies are
  blocked for `flowdesk.app`.
