# Flowdesk FAQ

## I can't sign in. What should I check?

Most sign-in problems have one of a handful of causes. Go through them in order:

1. **The error message.** Every sign-in error has a code (for example `AUTH_423_LOCKED`); see
   [Error codes](error-codes.md) for what each one means.
2. **Too many attempts.** After 5 wrong passwords in 15 minutes the account is locked for
   30 minutes. See [Signing in](sign-in.md#account-lockout).
3. **Your organization uses SSO.** If your admin turned on "Require SSO", the email and password
   form no longer works for you: use **Sign in with SSO**. See [Single sign-on](sso.md).
4. **Two-factor codes.** Codes rejected right after the password usually mean the clock on your
   phone is off. See [Two-factor authentication](two-factor.md#codes-are-rejected).
5. **Your organization's subscription.** If an invoice is unpaid for more than 14 days, the
   workspace is suspended and members can't sign in. See [Billing](billing.md#unpaid-invoices).
6. **An invitation link.** Invitations expire after 7 days. See
   [Members and invitations](members-and-invites.md#invitations).
7. **The desktop app.** Check [Known issues](known-issues.md) for your version.

If none of these fits, contact support with the error code and the time you tried.

## I forgot my password

Click **Forgot password?** on the sign-in page and enter your email. The reset link arrives from
`no-reply@flowdesk.app` within a few minutes (check spam) and is valid for 1 hour. Resetting the
password also unlocks a locked account.

## Which browsers are supported?

The two latest versions of Chrome, Edge, Firefox and Safari. Yandex Browser and other
Chromium-based browsers work but are not tested.

## Is there a desktop or mobile app?

Yes: Flowdesk for macOS and Windows, and for iOS and Android. They sign in through your
browser and then return you to the app. Updates: on macOS **Flowdesk › Check for updates**, on
Windows **Help › Check for updates**.

## Where is my data stored?

In the EU (Frankfurt) for organizations created in the EU, otherwise in the US (Virginia).
Enterprise customers can choose the region.

## How do I contact support?

From the app: **Help › Contact support** (the ticket is created with your account and the last
error code attached), or by email at support@flowdesk.app. Business and Enterprise plans get a
first reply within 4 business hours; other plans within 1 business day.
