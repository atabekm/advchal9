# Signing in

Flowdesk accepts three ways of signing in: **email and password**, **Sign in with Google**, and
**single sign-on (SSO)** for organizations on the Business and Enterprise plans. Which ones you
can use depends on your organization's settings.

## Passwords

A password needs at least 10 characters. It is checked against lists of leaked passwords;
a rejected password says so. Changing your password signs you out on all other devices.

## Resetting a password

**Forgot password?** on the sign-in page sends a reset link to your email from
`no-reply@flowdesk.app`. The link is valid for **1 hour** and can be used once. If no email
arrives within 10 minutes, check the spam folder, then ask your admin to confirm the email
address on your account.

Resetting your password also **unlocks** an account that was locked after too many attempts.

If your organization requires SSO, there is no Flowdesk password to reset: the reset email
says so and points you to your company's identity provider.

## Account lockout

After **5 failed password attempts within 15 minutes**, the account is locked for
**30 minutes**. While it is locked, every sign-in attempt fails with `AUTH_423_LOCKED`
("Too many attempts. Try again later"), even with the correct password, and does not extend
the lock.

To get back in sooner:

- reset your password with **Forgot password?**: a completed reset unlocks the account at once;
- or ask an admin of your organization to open **Admin › Members**, find you and click
  **Unlock**.

Support can't unlock accounts on the Free and Team plans faster than these two ways.

## Sign in with Google

Uses your Google account with the same email address as your Flowdesk account. If your Flowdesk
email changes, Google sign-in stops working until you sign in with a password once and link
Google again under **Profile › Sign-in methods**.

## Sessions

A browser session lasts 30 days. Desktop and mobile apps keep you signed in with a refresh token
stored in the system keychain; it is renewed automatically. **Profile › Sessions** lists your
active sessions and lets you sign out of each.
