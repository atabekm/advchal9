# Known issues

Problems we know about, with workarounds. Fixed issues stay listed for 60 days.

## Desktop app for macOS 3.4.0 and 3.4.1: sign-in loop

**Status: fixed in 3.4.2 (released 2026-10-02).**

After signing in through the browser (with Google, SSO or a password), the browser says you are
signed in, but the app shows the sign-in screen again. It happens on macOS 26 because the app
can't save its refresh token in the keychain. The web app is not affected.

Fix: update the app to 3.4.2 or later with **Flowdesk › Check for updates**, or download it from
`flowdesk.app/download`. If the app can't get past the sign-in screen to update, download the
installer from the website and install it over the old version. If the loop continues after
updating, open **Keychain Access**, delete the items named "Flowdesk", and sign in again.

## Mobile app on Android 16: notifications delayed

**Status: investigating.**

With battery optimisation on, push notifications can arrive up to 15 minutes late. Workaround:
**Settings › Apps › Flowdesk › Battery › Unrestricted**.

## Calendar view: tasks without a due time shift by a day

**Status: fixed on 2026-09-24.**

In time zones east of UTC+10, tasks due on a date (without a time) appeared one day early in the
calendar view. Reload the page if you still see it.

## Safari 26: drag and drop of attachments fails

**Status: workaround available.**

Dropping files onto a task does nothing in Safari 26.0. Use the **Attach** button, or update
Safari to 26.0.1.
