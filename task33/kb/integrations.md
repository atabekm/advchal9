# Integrations

Integrations are available on the Team plan and above. Admins manage them in
**Admin › Integrations**.

## Slack

Sends task notifications to Slack channels and lets people create tasks with `/flowdesk`.

- Connect: **Admin › Integrations › Slack › Connect**, then choose channels per project.
- The connection uses the Slack token of the person who connected it. If that person leaves the
  Slack workspace, or a Slack admin removes the app, Slack revokes the token: notifications stop
  and the integration shows **Disconnected** (`SLACK_TOKEN_REVOKED`). An admin has to click
  **Reconnect**; channel settings are kept.
- Private channels: invite the Flowdesk bot to the channel (`/invite @Flowdesk`) or it can't
  post there.

## GitHub

Links pull requests and commits to tasks when their title or branch contains the task key
(`OPS-142`). Install the Flowdesk GitHub app from **Admin › Integrations › GitHub**.
A merged pull request can move the task to Done (per project setting).

## Google Calendar

Shows tasks with due dates in a Google Calendar. Each member connects it in
**Profile › Integrations**; it's one-way (Flowdesk → Calendar), updated every 15 minutes.

## Zapier

Use an API key with the right scopes (see [API keys](api.md)). Zaps break when the key is
revoked.
