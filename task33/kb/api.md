# API and API keys

The REST API lives at `https://api.flowdesk.app/v2`. It is available on the Team plan and above.

## Authentication

Every request needs an API key in the `Authorization` header:

```
Authorization: Bearer fd_live_3f9a...
```

Keys start with `fd_live_`. Query parameters (`?api_key=`) are not accepted.

## Creating and managing keys

Admins and owners create keys in **Admin › API keys › New key**, give them a name and choose
scopes (`tasks:read`, `tasks:write`, `projects:read`, `projects:write`, `members:read`). The
full key is shown once; afterwards only its prefix is visible.

A key belongs to the person who created it and acts with their permissions. A key is
**revoked**:

- when someone revokes it in **Admin › API keys**;
- automatically, when the member who created it is **deactivated** or removed from the
  organization;
- when the organization's workspace is suspended (it works again after payment).

A revoked key can't be restored: create a new key and replace it in your integration. To avoid
breakage when people leave, create integration keys from a dedicated service member.

## Errors

| status | code | meaning |
| --- | --- | --- |
| 401 | `API_KEY_INVALID` | the key doesn't exist, was revoked, or the header is malformed |
| 401 | `API_KEY_MISSING` | no `Authorization` header |
| 403 | `API_KEY_SCOPE` | the key lacks the scope for this endpoint |
| 403 | `AUTH_402_ORG_SUSPENDED` | the workspace is suspended |
| 429 | `RATE_LIMITED` | over the rate limit; wait for `Retry-After` seconds |

## Rate limits

600 requests per minute per key, 6,000 per minute per organization. Responses carry
`X-RateLimit-Remaining`. Bulk endpoints count as one request.

## Webhooks

**Admin › Webhooks** sends task and project events to your URL, signed with
`X-Flowdesk-Signature` (HMAC-SHA256 of the body with the webhook secret). Failed deliveries are
retried 5 times over 24 hours.
