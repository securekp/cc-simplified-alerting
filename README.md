# Simplified Alerting

Find every Source and Destination that nothing is watching, and create the alert for it in a few clicks.

## Summary

Simplified Alerting is a Cribl app for per-feed delivery alerting. It discovers which Sources and Destinations are actually enabled, shows each one's health and whether an alert is already watching it, and bulk-creates the missing alerts from one template.

It is an **authoring tool**: every alert it writes is an object Cribl itself creates in its own UI, evaluated by Cribl's own engine. The app never evaluates anything, and it never deletes anything.

## What This App Does

* **Primary purpose:** close the gap between "here are my enabled feeds" and "each one is watched," so a deployment is not running with no per-feed alerting at all.
* **Key capabilities:**
  * A coverage table of every enabled Source and Destination, with health, a separate error indicator, and one column answering "is anything watching this for a delivery stop?"
  * Filters for uncovered, unhealthy, and has-an-error, plus multi-select and "select all uncovered."
  * Bulk create from a template, with a mandatory preview showing the exact payload of every object that will be written.
  * A click-through configuration view for any alert attributed to a feed, built from the object as Cribl stored it.
* **Intended users:** Cribl platform admins.
* **Works with:** Cribl Stream (Cribl.Cloud, hybrid, or distributed), plus Cribl Insights for the monitor mechanism.

**One intent: is this feed still delivering data?** A Source proves a stop with a volume condition, a Destination with a health condition. The admin does not choose between them — the app picks from what the deployment offered for that direction.

**Health is shown, not alerted on.** `status.health` is displayed per feed because a Red feed with nothing watching it is the most important row in the table, but the app authors no separate health alert: the catalogue offers no Source health condition, and expressing one as a monitor would mean composing PromQL, which the app deliberately does not do.

## When To Use This App

* A deployment has grown past the point where per-feed alerts get hand-authored, and most feeds are watched by nothing.
* New Sources or Destinations were added and need the same alert the existing ones have.
* You want to audit what alerting coverage actually exists, per feed, without opening each Notification in Cribl.

## Before You Install

* **Required deployment:** Cribl Stream with at least one worker group of `type: stream`. Edge fleets and Search/Lake feeds are out of scope.
* **Required permissions:** a Cribl admin role. The app reads worker groups, inputs, outputs, notification conditions, notifications, notification targets/templates/policies, and Insights monitors; it writes notifications and Insights monitors. Every path is declared in `config/policies.yml`.
* **Required external systems:** none.
* **Required configuration values:** none. Condition ids, their `conf` schemas, the monitor host group, and the monitor query are all discovered at runtime — nothing is hardcoded and nothing is asked for up front.
* **Known limits:** Pack-scoped feeds (`type:pack.feedId`) are not covered by the MVP and are called out in the UI rather than silently omitted. The Insights monitor mechanism needs a group whose monitor collection answers and a shipped monitor whose query can be copied; where neither exists, the app falls back to notifications and says so.

## Installation

Use Marketplace installation as the default path whenever the app is available there.

### Install From Marketplace or URL
1. Go to Apps in your Cribl environment.
2. Choose the Marketplace or import-from-URL option.
3. Install from the Marketplace if the app is listed there, or import the Marketplace-hosted URL.
4. Review the app details and complete installation.

### Install From Git
Each release tag carries the built pack layout (`static/`, `default/`), so Cribl's "Import from Git" can install it directly:

1. In Cribl, go to Apps and choose import from Git.
2. Use the repository URL from the metadata table below, and a release tag (or `latest`).

### If The App Is Not Yet In The Cribl Marketplace
1. Run `npm run package` to produce the installable `.tgz` in `build/`, or download it from the GitHub Release.
2. In Cribl, go to Apps and choose import from file.
3. Upload the `.tgz` and complete installation.

## Configuration

There is nothing to configure before first use. The only settings are made inside the bulk-apply drawer and remembered for the next run:

| Setting | Required | Description | Example | Scope |
|---|---|---|---|---|
| Alert mechanism | Yes, per direction | Insights monitor, or a notification on a discovered condition. Only shown when both are usable. | `monitor` | per-app |
| Condition and its fields | Yes, when the mechanism is a notification | Generated from the condition's own JSON Schema, so the fields differ per direction. | `no-data`, `timeWindow: 60s` | per-app |
| Monitor template and threshold | Yes, when the mechanism is a monitor | Which shipped monitor's query to copy, and the one threshold the new monitor carries. | `source_data_in_rate`, `less_than 1` | per-app |
| Delivery route | Yes | A Cribl notification policy, or notification targets with an optional template each. | `targets` | per-app |
| Email recipient | Only when an smtp target is chosen | Written onto the monitor as `params.to`, which is where the shipped email template reads the address from. | `you@example.com` | per-app |
| Create disabled | No | Create the alerts disabled so they can be reviewed in Cribl before they can fire. | `false` | per-app |

Defaults are safe: the mechanism opens on whichever route is usable, no notification target is ever preselected, and nothing is written until an explicit preview is confirmed. Settings are stored **per app**, not per user, so a team applies consistent windows and thresholds.

## How To Use

### Typical Workflow
1. Open the app from the Apps page. It discovers worker groups, feeds, health, and existing alerts.
2. Filter to **uncovered only** (optionally **unhealthy only**) to see the feeds that need an alert.
3. Select rows, or use "select all uncovered." The action bar opens the bulk-apply drawer.
4. Configure: mechanism per direction, that mechanism's settings, and where the alerts are delivered.
5. **Review the preview.** It lists every object that will be written, as the exact JSON payload. For a monitor that is two objects — the monitor and the notification that routes it.
6. Confirm. Alerts are created one at a time, with a per-item result, the created object inline, and a link into Insights.
7. Click any alert chip in the coverage table later to see the stored configuration.

### First-Run Checklist
* Confirm the worker-group selector lists the groups you expect (only `type: stream` groups are shown).
* Read any notice at the top of the page — it names a capability that is unavailable and why.
* Check the Delivery section: if the deployment has no notification policies, choose targets instead, or the alerts will fire and deliver nothing.

## Permissions

The app needs an admin role to read platform configuration and to create alerting objects. There is no app-level access filtering: the app renders what the API returns and lets Cribl RBAC and worker-group ACLs be the single source of truth.

Every capability degrades independently and never blanks the page. If notifications cannot be created, monitors are offered instead; if monitors cannot be created, notifications carry the app; if neither can, the table still renders as a read-only coverage and health audit.

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/master/groups` | Worker groups, filtered in app code to `type === 'stream'`. |
| GET | `/m/:gid/system/inputs` | Enabled Sources, with `status.health` and `status.metrics` inline. |
| GET | `/m/:gid/system/outputs` | Enabled Destinations, with `status.health`, `status.metrics`, and `status.error`. |
| GET | `/m/:gid/system/status/inputs` | Per-Worker-Process `healthCounts`, fetched lazily when a health cell is expanded. |
| GET | `/m/:gid/system/status/outputs` | The same, for Destinations. |
| GET | `/conditions` | The notification condition catalogue and each condition's `conf` JSON Schema, which generates the settings form. |
| GET | `/m/:gid/system-insights/healthcheck` | Whether a monitor written to that group would actually be evaluated. Read before the monitor mechanism is offered. |
| GET | `/notifications` | Existing alerts, for the coverage column and the configuration view. |
| POST | `/notifications` | Creates a per-feed condition notification, and the bridge that routes a monitor's output. |
| GET | `/notification-targets` | Target ids, so the admin can route by target. |
| GET | `/notification-templates` | Message templates, paired with a target of the same `type`. |
| GET | `/notification-policies` | Counted only. A policy-routed alert on a deployment with no policy delivers nothing, which is worth saying before anything is written. |
| GET | `/m/:gid/alert/monitors` | Finds which group hosts the monitor collection, supplies the shipped query a new monitor copies, and attributes existing monitors to feeds. |
| POST | `/m/:gid/alert/monitors` | Creates an Insights monitor. |
| PATCH | `/m/:gid/alert/monitors/*` | The recovery when a POST is rejected because that id already exists — never a blind first move. |

**No `DELETE` is granted anywhere**, and no notification item path is granted at all. The app creates alerts; Cribl edits and removes them.

## External API Access

The app makes **no external calls** and holds no third-party secrets.

### Default Configuration
* `config/proxies.yml` — intentionally empty; there are no external integrations.
* `config/policies.yml` — every Cribl API path the app calls, with the narrowest method set that works, including the `/m/:gid/...` variants.

## Data And Storage

The app-scoped KV store is the app's only persistence. Browser storage (`localStorage`, `sessionStorage`, `IndexedDB`, cookies) is never used — the app runs in a sandboxed iframe where it is unreliable.

* `cc-simplified-alerting/managed/{notification|monitor}/{id}` — one record per alert the app created, so the coverage column can distinguish "created here" from "unmanaged" without inferring ownership from names. **This is a cache, not the truth**: it is reconciled against the live reads on every load, stale entries are dropped, and unregistered alerts still count toward coverage as unmanaged.
* `cc-simplified-alerting/template-defaults` — the last-used mechanism, condition, `conf`, and monitor settings per direction, plus the routing choice. Validated field by field on read; a deleted target or an unusable mechanism falls back rather than being sent.

Data is shared across users of the app, by design. Nothing is stored encrypted because nothing stored is a secret; the email recipient is personal data and is kept only so an admin does not retype it every run. Uninstall behaviour follows the platform's own KV lifecycle — **alerts already created in Cribl are not removed**, since they are Cribl's objects and not the app's.

## Support

### Community-Maintained
This app is community-owned and community-maintained. It is **not an official Cribl product**, and it is not supported, tested, or maintained by Cribl — Cribl Support does not cover it. Review and test it in a non-production environment before relying on it.

Open an issue in the repository for bugs and questions, or contact the author listed in the metadata table below.

## Known Limitations

* **Pack-scoped feeds are not covered.** They carry real traffic and are named in the UI rather than quietly omitted.
* **Alerts cannot be edited or deleted from the app.** Tuning an existing alert, drift re-scan, and firing history are all deferred; the app links into Cribl for those.
* **Coverage is a configuration question, not a firing question.** The app can prove an alert exists, is enabled, and has a route; it cannot prove anyone received it.
* **Policy routing cannot be confirmed.** The app counts policies but does not read their matchers, so a policy-routed alert is reported as "which policy carries this is decided in Cribl."
* **A condition notification cannot carry an email recipient.** It has no `params` field; the address rides on a monitor only.
* **Edge fleets, Search, and Lake feeds are out of scope.**

## Troubleshooting

### A notice says a capability is unavailable
That is the intended behaviour, and the notice names the endpoint and the prefix that was tried. `/alert/monitors` and `/system-insights/*` answer only under `/m/{gid}/`, so a root-prefixed 404 is not evidence the route is absent.

### Every row in the drawer is blocked
Either the condition catalogue offers nothing for that direction (condition ids are never guessed), or no group hosts a monitor collection with a shipped query to copy. The drawer says which, per direction.

### Alerts were created but nobody was notified
Check the delivery route. A policy-routed alert on a deployment with **zero** notification policies fires and delivers nothing — the app warns about this in three places, and the configuration view of an existing alert will say so too. An smtp target with no recipient renders an empty address and the send fails.

### An alert this app created reads as "not created by this app"
The KV registry entry did not save, or the app was renamed since. Ownership then falls back to markers the app wrote into the object itself, and both the previous id namespace and the previous description marker are still recognised.

## Development

```bash
npm install
npm run dev      # Vite dev server; the platform globals come from the dev init script
npm test         # node --test over tests/ — no browser, no extra dependency
npm run lint     # oxlint
npm run build    # tsc -b (app + tests) then vite build
npm run package  # build, then produce the installable .tgz in build/
```

`npm test` covers the pure logic the coverage table and the two write payloads depend on:
the `type:id` metric join, health normalisation, alert attribution, the plan the preview
renders, schema-driven condition forms, routing shapes, the monitor payload and engine
check, and the client's pagination rules. Everything under test is deliberately free of
React and `fetch`, which is why it needs no test framework beyond Node's own runner.

The app can only be exercised end to end inside Cribl (or `npm run dev` against a real
org), because every capability is decided from live API responses.

## Project Layout

```text
src/
  App.tsx            coverage table, filters, and the bulk-apply entry point
  api/               one module per Cribl surface; all fetches go through api/client.ts
  components/        Capra-based UI: coverage table, bulk-apply drawer, config view
  hooks/             discovery, apply, URL filter state
  lib/               pure logic: feeds, join, attribution, payloads, plan, routing, filters
tests/               node --test suites for everything in src/lib and src/api
config/
  policies.yml       every Cribl API path the app calls
  proxies.yml        intentionally empty — this app has no external integrations
scripts/             Cribl-Community build scripts: package.mjs, pkgutil.mjs, prepare-git-pack.mjs
.github/workflows/
  release.yml        tag-triggered release: lint, test, package, publish to the dispensary
APP_DEFINITION.md    the problem statement, workflows, and verified live findings
APP_BRIEF.md         implementation guide generated from the definition
CLAUDE.md            the rules an agent working on this app must not break
LICENSE
README.md
```

## Versioning And Releases

* Semantic versioning, tracked in `package.json`.
* Releases are triggered by pushing a `v*` tag, which runs `.github/workflows/release.yml`: lint, test, package, GitHub Release, and upload to the Packs Dispensary. Append `-staging` to the tag (`v1.0.2-staging`) to publish to staging only.

  ```bash
  npm version patch
  git push origin main --follow-tags
  ```

* Upgrade notes whenever the KV shape, the reserved id namespace, or a written payload changes — all three affect objects already living in a customer's deployment.

## Contributing

`CLAUDE.md` is the short form of the rules this app is built on; `APP_DEFINITION.md` is the long form, including the findings verified against a live deployment. Read both before proposing a change — several of the rules exist because the obvious alternative silently produced an alert that could never fire.

All four gates must pass: `npx tsc -b`, `npm test`, `npm run lint`, `npm run build`.

## License

This app is licensed under the terms in [LICENSE](./LICENSE).

## App Metadata

| Field | Value |
|---|---|
| App Name | Simplified Alerting |
| App ID | cc-simplified-alerting |
| Version | 1.0.1 |
| Author | Kelsey Prior - kprior@cribl.io |
| Support Model | community |
| Support Label | Community-Maintained |
| Support Contact | kprior@cribl.io |
| License | Apache-2.0 |
| License File | [LICENSE](./LICENSE) |
| Product Tags | stream |
| Category | monitoring |
| Audience | admin |
| Availability | community |
| Requires External Access | no |
| Repository | https://github.com/Cribl-Community/cc-simplified-alerting |
| Documentation | [README](./README.md) |
| README Schema Version | 1.0 |
