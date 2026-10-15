"""The CRM: organizations, users and tickets from a JSON file, rendered as text a model can read.

Each lookup returns readable lines, not the raw record: dates come with how long ago they were
("2026-10-06 09:00 UTC (9 days ago)"), ids with names, an organization's settings spelled out.
An 8B model reads "invitation sent 9 days ago, not accepted" reliably; it doesn't reliably
subtract ISO timestamps.

"Now" is the file's `today`, so the demo data doesn't age.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path


class CRMError(Exception):
    pass


def parse_time(value: str) -> datetime:
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=UTC)


class CRM:
    def __init__(self, data: dict):
        self.today = parse_time(data["today"]) if data.get("today") else datetime.now(UTC)
        self.orgs = {o["id"]: o for o in data.get("organizations", [])}
        self.users = {u["id"]: u for u in data.get("users", [])}
        self.tickets = {t["id"]: t for t in data.get("tickets", [])}

    @classmethod
    def load(cls, path: Path | str) -> CRM:
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    # --- lookups ---

    def ticket(self, ticket_id: str) -> dict:
        tid = normalize_ticket_id(ticket_id)
        if tid not in self.tickets:
            raise CRMError(f"no ticket {ticket_id!r}")
        return self.tickets[tid]

    def user(self, user: str) -> dict:
        """By id ("u_102") or email."""
        key = user.strip().lower()
        for u in self.users.values():
            if u["id"] == key or u["email"].lower() == key:
                return u
        raise CRMError(f"no user {user!r} (give a user id like u_102, or an email)")

    def user_tickets(self, user_id: str) -> list[dict]:
        uid = self.user(user_id)["id"]
        return sorted((t for t in self.tickets.values() if t["user"] == uid), key=lambda t: t["created"], reverse=True)

    # --- rendering ---

    def when(self, value: str | None, date_only: bool = False) -> str:
        if not value:
            return "never"
        t = parse_time(value)
        stamp = t.strftime("%Y-%m-%d") if date_only or len(value) == 10 else t.strftime("%Y-%m-%d %H:%M UTC")
        return f"{stamp} ({self.ago(t)})"

    def ago(self, t: datetime) -> str:
        delta = (self.today - t).total_seconds()
        future = delta < 0
        s = abs(delta)
        if s < 3600:
            n, unit = max(1, round(s / 60)), "min"
        elif s < 86400:
            n, unit = round(s / 3600), "hour"
        else:
            n, unit = int(s // 86400), "day"  # whole days: "17 days ago", not a rounded-up 18
        if unit != "min" and n != 1:
            unit += "s"
        return f"in {n} {unit}" if future else f"{n} {unit} ago"

    def person(self, user_id: str) -> str:
        u = self.users.get(user_id)
        return f"{u['name']} ({user_id})" if u else user_id

    def ticket_text(self, ticket_id: str) -> str:
        t = self.ticket(ticket_id)
        u = self.users.get(t["user"], {})
        org = self.orgs.get(u.get("org", ""), {})
        env = ", ".join(f"{k} {v}" if k not in {"app", "browser", "os"} else str(v)
                        for k, v in (t.get("environment") or {}).items())
        lines = [
            f"ticket {t['id']} · status {t['status']} · priority {t['priority']} · area {t.get('area', '-')}",
            f"subject: {t['subject']}",
            f"created: {self.when(t['created'])}",
            f"customer: {u.get('name', '?')} <{u.get('email', '?')}> ({t['user']}), {u.get('role', '?')} of "
            f"{org.get('name', '?')} ({u.get('org', '?')})",
            f"error code attached by the app: {t.get('error_code') or 'none'}",
            f"environment: {env or 'unknown'}",
            "conversation:",
        ]
        for m in t.get("messages", []):
            lines.append(f"  [{parse_time(m['at']).strftime('%Y-%m-%d %H:%M')} {m['from']}] {m['text']}")
        return "\n".join(lines)

    def user_text(self, user: str) -> str:
        u = self.user(user)
        org = self.orgs.get(u["org"], {})
        auth = u.get("auth", {})
        role = u["role"] + (", billing admin" if u.get("billing_admin") else "")
        lines = [
            f"user {u['id']} · {u['name']} <{u['email']}> · prefers language: {u.get('language', 'en')}",
            f"organization: {org.get('name', '?')} ({u['org']}) · plan {org.get('plan', '?')} · role {role}",
            f"account status: {self._status(u)}",
            f"sign-in methods: {', '.join(auth.get('methods') or []) or 'none yet'} · two-factor: "
            f"{auth.get('two_factor', 'off')}"
            + (f" ({auth['backup_codes_left']} backup codes left)" if "backup_codes_left" in auth else ""),
            f"last successful sign-in: {self.when(auth.get('last_login'))}",
        ]
        failures = auth.get("recent_failures") or []
        lines.append("recent sign-in failures: " + ("; ".join(
            f"{f['code']} ×{f['count']}, last {self.when(f['at'])}" for f in failures) or "none"))
        clients = []
        for c in u.get("clients", []):
            if c["app"] == "api":
                errs = "; ".join(f"HTTP {e['status']} {e['code']} ×{e["count"]}, last {self.when(e["at"])}"
                                 for e in c.get("recent_errors", []))
                clients.append(f"API with key {c['key']}" + (f" (recent errors: {errs})" if errs else ""))
            else:
                bits = [c.get(k) for k in ("version", "os", "browser") if c.get(k)]
                clients.append(f"{c['app']} app" + (f" ({', '.join(bits)})" if bits else ""))
        lines.append(f"clients: {'; '.join(clients) or 'none'}")
        lines += ["", *self.org_lines(org)]
        return "\n".join(lines)

    def _status(self, u: dict) -> str:
        status = u["status"]
        if status == "locked" and u.get("locked"):
            lk = u["locked"]
            return (f"LOCKED since {self.when(lk['since'])}, reason: {lk['reason']}; the lock ends "
                    f"{self.when(lk['until'])}")
        if status == "invited" and u.get("invite"):
            inv = u["invite"]
            return (f"INVITED, has not accepted yet: invitation sent {self.when(inv['sent'])} by "
                    f"{self.person(inv['invited_by'])}")
        if status == "deactivated":
            return f"DEACTIVATED on {self.when(u.get('deactivated'))}"
        return status

    def org_lines(self, org: dict) -> list[str]:
        if not org:
            return []
        sub = org.get("subscription", {})
        if sub.get("status") == "past_due":
            subscription = f"PAST DUE since {self.when(sub['past_due_since'])}"
            if sub.get("suspended_since"):
                subscription += f"; workspace SUSPENDED since {self.when(sub['suspended_since'])}"
            if sub.get("unpaid_invoice"):
                subscription += f"; unpaid invoice {sub['unpaid_invoice']} ({sub.get('amount', '?')})"
        else:
            subscription = sub.get("status", "?") + (f", renews {sub['renews']}" if sub.get("renews") else "")
        sso = org.get("sso", {})
        if sso.get("enabled"):
            sso_text = (f"{'REQUIRED' if sso.get('required') else 'enabled, optional'} via {sso.get('provider')} "
                        f"({sso.get('protocol', 'SAML')}) for {sso.get('domain', '?')}")
        else:
            sso_text = "off"
        members = [u for u in self.users.values() if u["org"] == org["id"]]
        lines = [
            f"organization {org['name']} ({org['id']}):",
            f"  plan: {org.get('plan')} · seats: {org.get('seats')} · members: "
            f"{sum(m['status'] != 'deactivated' for m in members)}",
            f"  subscription: {subscription}",
            f"  single sign-on: {sso_text}",
            f"  two-factor required for all members: {'yes' if org.get('require_2fa') else 'no'}",
        ]
        admins = [f"{m['name']} ({m['id']}, {m['role']}{', billing admin' if m.get('billing_admin') else ''})"
                  for m in members if m["role"] in {"owner", "admin"} and m["status"] == "active"]
        lines.append(f"  owner and admins: {'; '.join(admins) or 'none'}")
        for i in org.get("integrations", []):
            since = f" since {self.when(i['since'])}" if i.get("since") else ""
            reason = f": {i['reason']}" if i.get("reason") else ""
            lines.append(f"  integration {i['name']}: {i['status'].upper()}{since}{reason}")
        for k in org.get("api_keys", []):
            text = f"  API key {k['prefix']} \"{k['name']}\" created {k['created']} by {self.person(k['created_by'])}"
            creator = self.users.get(k["created_by"], {})
            if creator.get("status") == "deactivated":
                text += f" (deactivated {creator.get('deactivated')})"
            if k["status"] == "revoked":
                text += f": REVOKED {k['revoked']} ({k.get('revoked_reason', 'no reason recorded')})"
            else:
                text += f": {k['status']}" + (f", scopes {', '.join(k['scopes'])}" if k.get("scopes") else "")
            lines.append(text)
        return lines

    def ticket_line(self, t: dict, with_user: bool = True) -> str:
        who = f" · {t['user']} {self.users.get(t['user'], {}).get('name', '?')}" if with_user else ""
        return (f"{t['id']} · {t['status']} · {t['priority']}{who} · {t['created'][:10]} · {t.get('area', '-')} · "
                f"{t['subject']}")

    def user_tickets_text(self, user: str, exclude: str | None = None) -> str:
        u = self.user(user)
        skip = normalize_ticket_id(exclude) if exclude else None
        rows = [t for t in self.user_tickets(u["id"]) if t["id"] != skip]
        if not rows:
            return f"{u['name']} ({u['id']}) has no {'other ' if skip else ''}tickets"
        lines = [f"tickets of {u['name']} ({u['id']}){' other than ' + skip if skip else ''}, newest first:"]
        for t in rows:
            lines.append("  " + self.ticket_line(t, with_user=False))
            last = next((m for m in reversed(t.get("messages", [])) if m["from"] == "agent"), None)
            if last:
                lines.append(f"    last agent reply: {last['text']}")
        return "\n".join(lines)

    def search_tickets_text(self, query: str = "", status: str | None = None, limit: int = 20) -> str:
        words = [w for w in query.lower().split() if w]
        rows = []
        for t in sorted(self.tickets.values(), key=lambda t: t["created"], reverse=True):
            if status and t["status"] != status:
                continue
            u = self.users.get(t["user"], {})
            hay = " ".join([t["id"], t["subject"], t.get("area", ""), t.get("error_code") or "", u.get("name", ""),
                            u.get("email", ""), *(m["text"] for m in t.get("messages", []))]).lower()
            if all(w in hay for w in words):
                rows.append(t)
        if not rows:
            return "no tickets match"
        limit = max(1, min(int(limit), 100))
        more = f"\n… {len(rows) - limit} more" if len(rows) > limit else ""
        return "\n".join(self.ticket_line(t) for t in rows[:limit]) + more

    def users_text(self, org: str | None = None) -> str:
        rows = [u for u in self.users.values() if not org or u["org"] == org]
        if not rows:
            return f"no users in {org!r}"
        return "\n".join(f"{u['id']} · {u['name']} · {self.orgs.get(u['org'], {}).get('name', u['org'])} · "
                         f"{u['role']} · {u['status']}" for u in rows)


TICKET_RE = re.compile(r"^\s*#?\s*(?:t\s*-?\s*)?(\d+)\s*$", re.I)


def normalize_ticket_id(value: str) -> str:
    """"T-1001", "t1001", "#1001", "1001" → "T-1001"."""
    m = TICKET_RE.match(value or "")
    return f"T-{m.group(1)}" if m else (value or "").strip()
