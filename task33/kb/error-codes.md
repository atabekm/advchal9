# Error codes

Every error Flowdesk shows has a code. The support form attaches the last one automatically.

## Sign-in errors

| code | message | what it means | what to do |
| --- | --- | --- | --- |
| `AUTH_401_BAD_PASSWORD` | Incorrect email or password | the password doesn't match | retype it, or reset it with **Forgot password?** |
| `AUTH_401_OTP_INVALID` | That code didn't work | the two-factor code is wrong or expired | check the device clock, or use a backup code ([Two-factor](two-factor.md#codes-are-rejected)) |
| `AUTH_402_ORG_SUSPENDED` | Your organization's workspace is suspended | the subscription is unpaid for more than 14 days | the owner or a billing admin pays in **Admin › Billing** ([Billing](billing.md#unpaid-invoices)) |
| `AUTH_403_SSO_REQUIRED` | Your organization requires single sign-on | password and Google sign-in are off for this organization | use **Sign in with SSO** ([SSO](sso.md#require-sso)) |
| `AUTH_403_DEACTIVATED` | This account has been deactivated | an admin deactivated the member | ask an admin of the organization |
| `AUTH_423_LOCKED` | Too many attempts. Try again later | 5 failed passwords in 15 minutes locked the account for 30 minutes | wait, reset the password, or ask an admin to unlock ([Lockout](sign-in.md#account-lockout)) |
| `INVITE_EXPIRED` | This invitation has expired | the invitation is older than 7 days | ask an admin to resend it ([Invitations](members-and-invites.md#invitations)) |
| `INVITE_USED` | This invitation was already used | the account exists already | sign in normally |
| `SSO_NOT_ASSIGNED` | You don't have access to this app | the identity provider hasn't assigned Flowdesk to you | ask your IT team |

## API errors

See [API errors](api.md#errors): `API_KEY_INVALID`, `API_KEY_MISSING`, `API_KEY_SCOPE`,
`RATE_LIMITED`.

## Export and import errors

| code | what it means | what to do |
| --- | --- | --- |
| `EXPORT_TOO_LARGE` | a CSV export over 50,000 rows | filter the export, or use the full workspace export ([Export](export-and-data.md#csv-export)) |
| `IMPORT_BAD_HEADER` | the CSV's first row doesn't match the template | download the template from the import dialog |

## Integration errors

| code | what it means | what to do |
| --- | --- | --- |
| `SLACK_TOKEN_REVOKED` | the Slack connection was revoked on Slack's side | reconnect Slack ([Slack](integrations.md#slack)) |
| `GITHUB_APP_SUSPENDED` | the Flowdesk GitHub app was suspended in your GitHub organization | unsuspend it in GitHub settings |
