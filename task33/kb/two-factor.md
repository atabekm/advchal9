# Two-factor authentication

Two-factor authentication (2FA) asks for a 6-digit code from an authenticator app (Google
Authenticator, Microsoft Authenticator, 1Password, Authy, ...) after your password. Turn it on
under **Profile › Security › Two-factor authentication**. Owners on Business and Enterprise can
require it for everyone in **Admin › Security**.

## Backup codes

When you turn on 2FA you get 10 one-time backup codes. Each can replace an app code once. Keep
them somewhere safe; **Profile › Security** shows how many are left and generates a new set.

## Codes are rejected

A code is valid for 30 seconds and is computed from the current time, so the clock of the
device running the authenticator app matters. If codes fail with `AUTH_401_OTP_INVALID` even
though you type them correctly, the device's clock is almost always off by more than 30 seconds.
This often happens after travelling, when the time zone or time was set by hand.

To fix it:

1. On the phone, turn on automatic date and time (Android: **Settings › System › Date & time ›
   Set time automatically**; iOS: **Settings › General › Date & Time › Set Automatically**).
2. In Google Authenticator on Android you can also use **Settings › Time correction for codes ›
   Sync now**.
3. Wait for a fresh code and try again.

Until the clock is fixed, a **backup code** gets you in.

## Lost phone

Sign in with a backup code and set up 2FA again on the new phone. Without backup codes, an
admin of your organization can reset your 2FA in **Admin › Members › … › Reset two-factor**
(Business and Enterprise). On other plans, contact support; we verify your identity before
removing 2FA, which takes up to 2 business days.
