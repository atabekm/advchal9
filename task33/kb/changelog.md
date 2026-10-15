# Changelog

## 3.4.2 (2026-10-02)

- Desktop (macOS): fixed the sign-in loop on macOS 26 where the app returned to the sign-in
  screen after signing in through the browser.
- Mobile: two-factor codes can be pasted from the clipboard.
- Web: faster loading of projects with more than 5,000 tasks.

## 3.4.1 (2026-09-22)

- Desktop: fixed a crash when opening very large attachments.
- Web: the calendar view shows week numbers (turn on in **Profile › Preferences**).

## 3.4.0 (2026-09-15)

- New: recurring tasks can repeat on the last working day of the month.
- New: **Admin › Members** shows each member's last sign-in and sign-in method.
- Desktop: the app now stores its refresh token in the system keychain.
- API: `GET /v2/tasks` accepts `updated_since`.

## 3.3.2 (2026-08-20)

- Desktop (macOS): fixed a crash on start on macOS 15.6.

## 3.3.0 (2026-07-28)

- New: full workspace export for Business and Enterprise.
- New: invitations can be resent from **Admin › Members › Pending**.
