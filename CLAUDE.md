# CLAUDE.md

This file provides guidance to Claude Code when working with this Cribl app.

## App Context

**Simplified Alerting** (`cc-simplified-alerting`) makes per-Source and per-Destination alerting fast to set up. It auto-discovers which Sources and Destinations are enabled on the platform, shows which are already watched, and lets a Cribl platform admin bulk-create alerts.

**There is one alerting intent: "tell me when this feed stops delivering data."** A Source proves a stop with a volume condition (`no-data` / `low-volume`); a Destination proves it with `unhealthy-dest`. The admin does not choose between them — the app picks the condition from what the deployment offered for that direction.

**Health is a display column, not an alerting intent.** `status.health` arrives inline with discovery and is shown per feed (with `status.error` beside it), so an admin can see a Red feed at a glance. The app does not create health alerts for Sources: there is no Source health condition in the catalogue, and a Source monitor watches throughput, not health. A Red Source with nothing watching it is still the loudest row in the table — via the volume condition.

This app is defined in `APP_DEFINITION.md` — read that for the comprehensive problem statement, workflows, and scope.

## Key References

- `AGENTS.md` — how to build the app and navigate the app runtime environment (fetch proxy, KV store, policies.yml, proxies.yml, Capra)
- `APP_DEFINITION.md` — full app requirements and workflows
- `APP_BRIEF.md` — implementation guide (generated from APP_DEFINITION)
- `openapi.json` — Cribl platform API definitions

## Architectural Rule 1: Authoring Tool, Never an Evaluator

The app generates alert configuration and writes it to Cribl. It never evaluates anything itself.

The app runs in a sandboxed iframe with no background runtime, so an app-owned alert engine would only evaluate while a browser tab was open — useless for alerting. **Do not add polling-based alert evaluation, in-app rule engines, or timers that decide whether something is firing.**

## Architectural Rule 2: Two Mechanisms, Both of Them Cribl's

The app writes alerts two ways, chosen **per direction** in the template. Both are objects Cribl itself creates in its own UI; neither is an engine this app invented. **Do not add a third.**

### Mechanism A — a Notification on a discovered condition

`POST /notifications` with a `condition` id read from `GET /conditions`.

```json
{
  "id": "csa-default-out_splunk",
  "condition": "unhealthy-dest",
  "group": "default",
  "targets": ["system_notifications"],
  "disabled": false,
  "conf": { "name": "out_splunk", "timeWindow": "60s", "notifyOnResolution": true }
}
```

Why: it consumes the platform's own verdict (so the app agrees with the Cribl UI), `timeWindow` gives sustained-state detection without flapping, `notifyOnResolution` gives recovery notices, `group` scopes it, and `conf.name` makes it per-feed by construction. It needs **neither the Insights metric catalogue nor a monitor engine**.

### Mechanism B — an Insights monitor, and the default

What the admin asked for: an alert that lands on the Insights alerts page with a chart, thresholds and an Activity trail, exactly like a native Insights alert, reachable at its own edit screen `/insights/alerts/monitors/edit/{id}`. Implemented in `src/api/monitors.ts` + `src/lib/monitorPayload.ts`.

**This is the preferred mechanism, and the drawer opens on it whenever it is usable** (`resolveMechanism` in `src/lib/plan.ts`; `DEFAULT_SETTINGS.mechanismBy` is `monitor` for both directions). A saved choice still wins while it remains usable, and a Notification is the fallback wherever a monitor is not — never a drawer of blocked rows.

**A monitor is named `{shipped monitor id}_{feed id}`** — `event_volume_in_rate_ZscalerWeb` — and the `name` field is set to the same string as the `id`, so the row on the Insights alerts page and the URL it links to read alike. Two consequences are handled in code, not documented as cautions:

- The id no longer proves this app minted it (there is no reserved prefix on a monitor). Authorship falls back to `APP_MONITOR_MARK`, the sentence `buildMonitor` writes at the head of `description`; `alertOwnership` takes it as the same class of evidence as the id namespace. Both markers keep a legacy form: `ally-` ids are still accepted alongside `csa-`, and the mark written under the app's previous name is still recognised, so alerts from earlier builds — and from before the rename — keep reading as app-created.
- The worker group and the feed type are no longer in the id, so two feeds can collide on one. `collisionBlock` in `plan.ts` **blocks both items** and names the clash, because `upsertMonitor` PATCHes on an id-exists rejection and would otherwise silently retarget the first feed's monitor at the second — leaving a feed that reads as watched by a monitor scoped to something else. A feed tag shared across groups stays a **warning** (the monitor works, it just watches both); a shared *id* is a **block**.

An Insights alert is **two objects**, and both are written: `POST /m/{gid}/alert/monitors` (PATCH on the item path is the recovery when the id exists), plus a bridge `POST /notifications` of `{"id":"monitor-{monitorId}","condition":"monitor-alerts","disabled":false,...routing,"conf":{}}`, where the routing fields are whichever route the admin chose — see "Routing is the admin's choice" below. Both routes are observed on this exact object: the Insights UI creates the bridge as `{"mode":"policy","targets":[],"templateTargetPairs":[]}`, and the same capture then shows it **changed** to `mode: "direct"` with a pair, because the deployment had no policy and the monitor was delivering nothing. Policy is therefore the default, not the safe answer.

Four rules keep this from producing a monitor that cannot fire — the worst outcome available to an alerting tool, and the reason each of these is enforced in code rather than documented as a caution:

1. **The host group is discovered by probing, never assumed, and is not the feed's group.** Monitors were observed in `default_search` while the feeds live in `default`. `discoverMonitorHost` prefers the group holding Cribl's shipped `isDefault` Stream monitors, because that is a group whose engine is demonstrably wired up.
2. **The PromQL query is copied verbatim from a shipped `isDefault` monitor, never composed.** Shipped queries use underscore metric names and an empty-string namespace matcher (`rate(total_in_bytes{namespace=""}[5m])`) that this app cannot verify from the browser. A hand-authored expression matching no series is a silent no-op. If no shipped monitor measures the direction's throughput, the item is **blocked**, not improvised.
3. **Per-feed scope goes in `rules[0].includedTags`, not in the query** — `{input: ["datagen:ZscalerWeb"]}`, exactly the `type:id` tags the metric join already builds. Only the feed tag is pinned: adding a `__worker_group` tag this deployment may not support would narrow the monitor to nothing.
4. **One rule, one enabled condition.** Every monitor Cribl ships has `enabled: true` on the object and `enabled: false` on all three severity thresholds, so coverage requires monitor-enabled **and** ≥1 enabled condition, and a created monitor carries exactly one threshold an admin can reason about.

`mode: "policy"` on the bridge is copied from the capture, and it is the **default** rather than a constant: monitor alerts route through notification **policies**, which this app does not create, so a deployment with no policy would get a monitor that fires on the Insights page and delivers nowhere. That is a real state — surfaced as `(not routed)` on the chip and a warning in the configuration view, never smoothed over — and it is also why the admin can route by target instead.

Monitor writes are gated on the `monitors` capability **only**. `alerting` reflects whether the *condition catalogue* is readable, which a monitor never consults — its bridge uses the fixed `monitor-alerts` condition. The two mechanisms fail independently and a denial is tracked per mechanism, so a denied monitor write must never block a Notification item in the same run.

### Routing is the admin's choice, and it is one choice across both mechanisms

**Where an alert is delivered is chosen in the drawer, not decided by the mechanism.** `Notification.mode` is `enum: ["direct","policy"]` with a three-branch `oneOf`, and the app offers exactly the two routes that enum names — `src/lib/routing.ts` is the whole of it, pure and shared, because a condition Notification and a monitor's bridge are the same kind of object:

- **`policy`** — `{"mode":"policy","targets":[],"templateTargetPairs":[]}`, copied field for field from the capture. The alert names nothing and a notification policy decides where it goes.
- **`targets`** — the alert names `/notification-targets` ids, optionally with a template per target.

Four rules, all enforced in `buildRouting`:

1. **A templated target is named inside its pair and nowhere else.** `mode: "direct"` **is** observed on the wire, and observed as a *repair*: a HAR of this org's Insights UI (2026-09-02, evening) shows a bridge created `mode: "policy"` on a deployment with zero policies — delivering nothing — then changed to `{"mode":"direct","targets":[],"templateTargetPairs":[{"targetId":"system_email","templateId":"default-email"}]}` → 200. Note **`targets: []`**. An earlier build of this app listed a templated target in `targets` *and* in its pair; that shape has never been seen from Cribl and risks a double send or an ignored field. Do not reintroduce it.
2. **Targets with no template collapse to a bare `targets: [...]`** — the third `oneOf` branch, and byte-for-byte the shape every alert this app created before the choice existed. Do not fill in a `mode` there; the `direct` branch requires `templateTargetPairs` `minItems: 1`. A **mixed** selection splits: pairs for the templated targets, `targets` for the rest, so no target is ever named twice.
3. **A template is paired with a target of the same `type`** (`default-email` renders `smtp`). A target with no matching template is normal, not broken — `system_notifications` is `bulletin_message` and no template ships for it — so a template is optional per target. A template whose `type` could not be read is offered anyway; an unreadable field is not evidence of a mismatch.
4. **An email recipient is not a routing field, and it is not optional either.** `default-email` renders `"to": "{{metadata.to}}"`, and `system_email` carries no address of its own (`errorCnt: 1` on that target when the recipient was missing). The same capture shows the address arriving on the **monitor** as `params.to` — `{"to":"kprior@cribl.io","unit":"none"}`, the only field that changed between the two HARs and present on none of the other 40 monitors. So `RoutingSettings.recipient` travels with the choice and `buildMonitor` applies it over the copied `params`; `buildRouting` must never put it on a Notification. **A condition Notification has no `params` and therefore no recipient** — that is a real limit of Mechanism A with an smtp target, said in the drawer, not papered over.

`policy` is the default **only where a policy could carry the alert**. It is what Cribl's own Insights UI posts when it *creates* a bridge, and monitors are the default mechanism — but where `GET /notification-policies` counts **zero**, `coerceRouting` opens on `targets` instead, because policy there is the one route known to deliver nothing. That is not the app choosing delivery: **no target is ever preselected**, so the admin still has to name one, and the drawer says why it moved. A saved choice of `policy` still stands and is warned about rather than overridden — the admin may be about to create the policy. `null` (unreadable) is not zero and keeps the policy default. Templates come from `GET /notification-templates?engine=handlebars`. Neither path appears in `openapi.json`; both answered 200 live (HAR, 2026-09-02), which is the only reason either is declared in `policies.yml`.

**Say "delivers nowhere" wherever it is provable, and only there.** Three places, because the drawer notice alone demonstrably was not enough — four alerts were created into that state with the warning on screen: the Delivery section, the **mandatory preview** (`deliveryWarning`, the screen the admin has to confirm), and the configuration view of an existing alert (`policyGap`, which is the only thing that combines the stored `mode` with the live policy count). `describeRouting` still answers `delivers: null` for policy mode and is right to — *which* policy matches an alert lives in an object this app does not read — but a **count** of zero is a fact, not a matching question.

**Neither is a fifth capability.** There are still four, and a template or policy read that fails costs no alert: templates unreadable → targets are still offered untemplated; the policy count unreadable → the drawer says it could not be checked rather than claiming there are none. Both are surfaced inline in the drawer beside the choice they affect, never as a page-level notice.

**Do not read routing back from the template that produced it.** `describeRouting` reads the **stored object**, for the same reason the whole configuration view does — the admin may have changed it in Cribl afterwards. For a monitor that means reading the *bridge* (`AttributedAlert.bridgeConfig`), because the route lives there and not on the monitor. **And read delivery from `targets` *and* the pairs, never from `targets` alone**: a `mode: "direct"` object has `targets: []`, so the earlier read reported the one alert Cribl itself had repaired as "nothing is sent" — the worst direction for that screen to err in, since it sends an admin to re-fix a working alert.

### The catalogue is asymmetric, and that is the whole design

Verified against the org on 2026-09-02 — this is why the condition is chosen **per direction**:

| Direction | Condition used | Signal it watches |
|---|---|---|
| Source | `no-data`, `low-volume`, `high-volume` | volume |
| Destination | `unhealthy-dest` | health |

Both satisfy the one intent. The `Signal` label (`health` / `volume` / `unclassified`) exists so the UI can say *what* a condition watches — **it is not a routing decision.** Both `health` and `volume` count as coverage; `unclassified` never does.

**Discover conditions, never hardcode them.** Call `GET /conditions?category=sources` and `GET /conditions?category=destinations`. Each condition returns a JSON Schema for its `conf` fields (titles, descriptions, patterns, duration minimums) — **generate the configuration form from that schema**, and prune the template's `conf` against it. The full catalogue read live on 2026-09-02 is 10 conditions: `unhealthy-dest`, `low-volume`, `high-volume`, `no-data`, `backpressure-dest`, `persistent-queue-usage`, `persistent-queue-usage-source`, `monitor-alerts`, `search`, `license-expiration`. Hidden conditions are excluded unless `showHidden` is set. **Never fabricate a condition id** — if a direction has none, say so and create nothing for it.

**Classify by what a condition watches, never by its `type`.** Six of the ten are `type: "metric"`, including `backpressure-dest` and both `persistent-queue-usage*`, which watch neither health nor volume. A `type === 'metric'` → coverage rule would file those as coverage and mark a feed watched for a delivery stop nobody is watching. Match on the id/name (`health`; `no-data|volume|byte|event|throughput|rate`) and return `unclassified` otherwise. Unclassified alerts attributed to a feed are shown in the coverage cell under "Also on this feed, but not watching for a delivery stop" — visible, never counted.

**`conf.name` is pinned to the feed, always.** Cribl's own `uischema` renders it `ui:disabled: true` with `default: "${IO_ID}"`. The template must never supply or override it; `buildNotification` applies it last so a template-supplied `name` cannot hijack a whole bulk run onto one feed.

**`conf` is stored and validated per direction.** `no-data` and `unhealthy-dest` declare different fields but share names like `timeWindow`, so a merged error bag would report a Source error against a Destination field or mask one with the other.

### How the monitor route came back

An earlier build fell back to `POST /alert/monitors` on an Insights metric wherever the catalogue offered nothing, and it was removed because of three unresolved problems:

1. `/alert/monitors` returns an Express 404 on the verification org despite being fully documented in `openapi.json`.
2. `MonitorConf.rules[]` is required and holds the threshold, but the spec gives no usable schema for it (`Rule.conditions[].condition` → `Condition` → `$ref: Function`, a pipeline-function schema — a generator collision) and the spec's own example ships `rules: []`.
3. Both monitor engines are dead there: `/system/messages` carries `SERVICE_DOWN_aetos` and `SERVICE_DOWN_lh_engine_metrics`, each "No workers registered".

**Problems 1 and 2 are now resolved by evidence, and the entries above are only true of the *unprefixed* path.** A HAR capture of the org's own Insights UI creating an alert (2026-09-02) shows:

- `GET`/`PATCH /api/v1/m/{gid}/alert/monitors/{id}` answer **200**. The route exists — under `/m/{gid}/`, not at the root. This is the same trap as `/system/inputs`. **`/system-insights/metrics`, `/system-insights/metrics/{name}` and `/system-insights/healthcheck` are group-prefixed too**, which is why `src/api/insights.ts` calls the healthcheck under `/m/{gid}/` and nowhere else. Note the group-prefixed catalogue returns **underscore-form** names (`total_in_events`, `service_in_bytes`) while `POST /insights/metrics/query` — which does work unprefixed — takes the dot-separated form (`total.in_bytes`). Nothing in the app reads either any more, so if a metric name is ever needed again, probe both live rather than trusting this note.
- A real `rules[]` from a working monitor, which is the missing schema: `rules: [{ name, showOnChart, conditions: [{ condition: { type: "greater_than", threshold: N }, enabled, labels: { severity: "critical"|"warning"|"info" } }], includedTags: {}, excludedTags: {} }]`, alongside `query` (a PromQL string, e.g. `rate(total_in_events{namespace=""}[5m])`), `product`, `params`, `schedule_interval_seconds`, `firing_after`, `ok_after`, `isDefault`.
- An "Insights alert" is **two objects**: the monitor, plus a bridge `POST /notifications` of `{"id":"monitor-{monitorId}","condition":"monitor-alerts","mode":"policy","disabled":false,"targets":[],"templateTargetPairs":[],"conf":{}}`. Note `mode: "policy"` — that is what the Insights UI posts on **create**. `GET /notification-policies` answers **200** (`{"items":[],"count":0}` on this org — the endpoint exists, there are simply none), which is why a later capture shows the same bridge being switched to `mode: "direct"` with `targets: []` and one `{targetId, templateId}` pair. `POST /notification-policies` also answers **200**, with per-feed scoping on exactly this app's own tag — `{"id":"ZscalerWeb","conditions":[[{"key":"input","operator":"=","value":"datagen:ZscalerWeb"}]],"templateTargetPairs":[…],"order":1,"final":false,"waitToGroup":0,"disabled":false}`, note the array-of-arrays `conditions`. **Recorded as evidence only: creating policies is still out of scope and `policies.yml` grants no POST there.** Do not add it without asking — a policy is deployment-wide routing, not a per-feed alert, and reshaping where a deployment's alerts go is not something an authoring tool should do unasked.
- The Insights alerts page loads `/products/stream/groups`, `/m/{gid}/alert/monitors`, `/notifications`, `/notification-targets`, `/m/{gid}/alert/silences` — so that page lists **monitors *and* notifications**. A per-feed condition Notification is not invisible there; what it lacks is a monitor's chart and threshold.
- Problem 3 is untested against the group-prefixed path and may still stand. `default_search` held the monitors in the capture while the feeds live in `default`, so **which group a per-feed monitor belongs in is an open question.**

Problems 1 and 2 are resolved by that evidence, so the monitor mechanism was rebuilt on it (see Rule 2, Mechanism B). Problem 3 is answered by construction rather than by a probe: the host group is the one whose monitor collection actually answers **and** holds the shipped Stream monitors, and `/m/{gid}/system-insights/healthcheck` is read before the capability is offered. `default_search` held the monitors in the capture while the feeds live in `default`, which is why the host group is discovered and never taken to be the feed's group.

What still holds, and the code depends on: **no Notification depends on a metric name**, so Insights can be denied, disabled, or absent without costing a single Notification write — that degradation is the monitor mechanism, never Mechanism A.

**There is no throughput-history column, and no metric query.** An earlier build read `POST /insights/metrics/query` to draw a per-feed sparkline; it is gone, along with `/system-insights/metrics*` and `/system/settings/insights`. Real-time throughput is what Cribl Insights itself is for, and a 96-pixel history duplicated it badly. **Do not reintroduce a metric-history read for display purposes.** The only Insights call left is `/m/{gid}/system-insights/healthcheck`, and it exists solely to refuse to create a monitor where nothing would evaluate it. Removing all of that cost no alerting capability, which is the point of the rule above.

### Facts that survive from the monitor work

Keep these — they are live-verified and still true, even though nothing currently uses them.

- **`health != 0`, never `health == 2`.** Metric `health.inputs` / `health.outputs` reads `0` = `Green`, `2` = `Red` (cross-checked on two feeds whose `status.health` read `"Red"`). `Yellow` and `Unknown` are unnumbered by observation, so any health rule must be expressed as `!= 0`.
- Query metric series with **`POST /system/metrics/query`** — `GET /system/metrics` is a different, GET-only endpoint; `POST /system/metrics/enum` enumerates dimension values.
- **A GET probe proves nothing about a POST-only route.** Express returns `Cannot GET` for those too.

### List-endpoint rules (these bite hard)

**Page every list endpoint to exhaustion** — `/notifications`, `/conditions` both take `offset`/`limit`. First-page-only reads make existing alerts invisible and watched feeds look unwatched.

**`limit` requires `offset` — always send both.** Proven live: `?limit=200` alone returns `{"status":"error","message":"missing 'offset' parameter, 'offset' is required when 'limit' is provided"}` from every list endpoint. That body has **no `items` key**, so a client reading `body.items ?? []` inverts the entire coverage table from one missing parameter. Build the two params together and validate the envelope.

**Never assume a documented path exists — probe it, and probe it at the right prefix.** On the verification org `/alert/monitors`, `/alert/history` and `/system-insights/metrics` all return Express 404s **at the root**, while `/conditions`, `/notifications`, `/notification-targets`, `/notification-policies` and `/system/settings/insights` answer normally there. A 404 at the root is not evidence the route is absent: `/m/{gid}/alert/monitors` and `/m/{gid}/system-insights/*` answer 200 (proven by HAR). Offer a capability only once its endpoint has answered, and name the missing endpoint **and the prefix you tried** when degrading.

### In the UI

Never hide what an alert actually is. Every alert chip in the coverage table is clickable and opens a configuration view built from the **stored object** as Cribl returned it. For a Notification each `conf` field is labelled from the condition's own schema and undeclared keys are listed rather than hidden; for a monitor the fields are named in the component, because no schema for one exists — and the query, the feed tags and each threshold's own `enabled` flag are all shown, because those three are what decide whether it can fire. The apply results step shows the created object(s) inline for the same reason.

**Every view links into Insights, and the link is per-object where one exists.** A monitor links to its own edit screen, `/insights/alerts/monitors/edit/{id}` — from the configuration view and from the apply result — because the admin has just created that object and wants to look at it. A condition Notification has no monitor edit screen, so its view leads with the Insights alerts page (proven by HAR to list notifications alongside monitors), says out loud that it has no chart there, and keeps the group's Notifications page as the secondary link to where it is actually edited. **Do not compose an Insights deep link that has not been observed live**, and every view states plainly that this app creates alerts and never edits them.

The chip says which mechanism it is (`Monitor · …`) and qualifies itself when it is not real coverage: `(disabled)`, `(not routed)`, `(unmanaged)`, `(owner unknown)`. **`(not routed)` covers two states, not one** — no routing object at all, *and* a routing object naming a notification policy on a deployment that has none (`policyGap`). The second is why the qualifier reaches Mechanism A too: four app-created alerts sat in exactly that state on the verification org while this table showed them as plain coverage.

## Implementation Rules Proven Against a Live Deployment

These were verified against a real Cribl Cloud org. They are the kind of thing that silently produces a wrong-looking table, so treat them as requirements, not tips. Full detail in `APP_DEFINITION.md` → "Verified Against a Live Deployment".

1. **Health arrives inline with discovery.** `GET /m/:gid/system/inputs` and `/system/outputs` already return `status.health` as a string, plus per-type `status.metrics` and (destinations) `status.error`. One call per group per direction fills the whole coverage table. `/system/status/*` is a lazy progressive enhancement, fetched only when a row expands to show `healthCounts`.
2. **Join on `type` + `id`, and match exactly.** Metric dimension values are fully qualified `type:id` (`syslog:in_syslog:udp`, `cribl_lake:palo_traffic`) while config objects key on the bare `id`. Construct `` `${type}:${id}` `` from the config object and compare for **exact equality** — never parse the dimension value apart, and never prefix-match. Verified live: a feed emits both a parent series and `:suffix` children (`subscription:zscaler_web_project` and `...:zscaler`) carrying the **same** value, so prefix matching double-counts. There is also an undimensioned roll-up series to exclude, and the metric store holds internal feeds (`ServiceTcp:*`, `cribl:CriblLogs`, `router:*`) plus Pack-qualified feeds (`type:packName.feedId`) that have no config row at all. **The config call is the spine; metrics join onto it, never the reverse.**
   - **Pack-scoped feeds are out of scope for MVP but carry real traffic** — say so in the UI rather than presenting a partial table as complete.
   - **`status.health` can be absent entirely** (observed `status: {}`), not just `Unknown`. Treat missing as `Unknown`, never as healthy.
3. **Green does not mean fine.** Feeds were observed `"Green"` while carrying a `status.error` ("There is an issue with the underlying destinations."). Do **not** redefine health to compensate — surface `status.error` as its own always-visible column so a Green-with-error feed is visibly not fine, and rely on the delivery alert to catch the consequence.
4. **`workerCount` from `/master/groups` is not a usable signal — do not consult it.** Reported live 2026-09-02: it read `0` for the `default` group while that group demonstrably had Workers running, and it is absent entirely on `defaultHybrid`. Parse it faithfully (`number | null`) but never let it block a write, never cite it as evidence in a reason, and never decorate a group label with it. A field that can be wrong must not be quoted at the admin as a fact.
5. **Filter groups on `type === 'stream'` in app code.** Asking the API for stream groups returned `outpost`-type groups too. Do not trust the request parameter.
6. **Filter feeds on `disabled !== true`.** Disabled feeds still report health (observed `disabled: true` and `"Green"`). Health is never the enabled test.
7. **A disabled alert is not coverage.** `disabled: true` on a Notification means it will not fire; counting it would report a watched feed that nothing is watching. For a monitor the same test is two-part — note the inverted sense (`enabled` on the object, `disabled` on a Notification) — and **both parts are required**: the monitor enabled, *and* at least one rule condition enabled. Every monitor Cribl ships is `enabled: true` with all three thresholds off.

## Workflows & Data

**Main workflows** (MVP is 1 and 2):

1. **Review alert coverage** — landing table of every enabled Source and Destination with current health, a separate error indicator, and one coverage column. An unhealthy feed with nothing watching it is the most important row in the app; style it that way.
2. **Bulk-create alerts from a template** — multi-select, pick the mechanism per direction, set that mechanism's settings per direction (the condition's own schema-driven fields, or the monitor's template/threshold/timing), choose the route (a notification policy, or targets with a template each), review a mandatory preview showing every object that will be written, confirm.
3. **Inspect a created alert** — click its chip to see the stored configuration, whichever mechanism it is.
4. *(Deferred)* **Tune an individual alert** — threshold-vs-history chart.
5. *(Deferred)* **Re-scan for coverage drift.**
6. *(Deferred)* **Verify alerts are working** — firing history.

**Key data the app reads:**

- Enabled Sources / Destinations **and their health** — `GET /m/:gid/system/inputs`, `GET /m/:gid/system/outputs`. Each object carries `disabled`, `type`, `id`, and `status.health` (`Green`/`Yellow`/`Red`/`Unknown`), plus `status.metrics` and, for destinations, `status.error`. Filter to `disabled !== true`.
- Worker groups — `GET /master/groups`, filtered in app code to `type === 'stream'`
- **Health detail (progressive enhancement)** — `GET /m/:gid/system/status/inputs`, `GET /m/:gid/system/status/outputs`. Adds `healthCounts` per state across Worker Processes, an `error` object, `pq` queue status, `timestamp`. Fetch lazily on row expand, not for the base table.
- Notification conditions + their schemas — `GET /conditions?category=...`, and that is the whole read. The list carries each condition's `schema` inline, so there is no per-condition call and `/conditions/*` is not granted.
- Insights engine health, on the monitor host group only — `GET /m/:gid/system-insights/healthcheck`. Read to decide whether a monitor written there would be evaluated, and for nothing else. There is no metric-catalogue read and no metric query: see "There is no throughput-history column" above.
- Existing alerts — `GET /notifications` (takes a `groupId` filter), and only the collection: coverage and the configuration view both read the stored object out of that list, so there is no per-alert read and no item path is granted. Matching these back to feeds is non-trivial: a Notification carries only a bare `conf.name`, so resolve direction from the condition's `category` and match on `(group, direction, id)`. A groupless Notification whose name matches feeds in two groups is genuinely ambiguous — **report it as unattributed rather than counting it toward both.** Never guess.
- Notification routing — three read-only lists, one per thing the choice needs: `GET /notification-targets` (target ids for the `targets` field), `GET /notification-templates?engine=handlebars` (a template's `type` is what pairs it with a target), and `GET /notification-policies` **for its count only** — a policy-routed alert on a deployment with no policy delivers nothing, and that is worth saying before anything is written. The app creates and edits none of the three.
- **Insights monitors** — `GET /m/:gid/alert/monitors`, paged like every other list endpoint, read for three things at once: to find which group hosts the collection, to supply the shipped `isDefault` queries a new monitor copies, and to attribute existing monitors to feeds via `rules[].includedTags`. `GET /m/:gid/system-insights/healthcheck` before the capability is offered.
- Bridge Notifications, from the same `GET /notifications` read: `{id: "monitor-{id}", condition: "monitor-alerts"}` carries no `conf.name` and belongs to no feed, so it is set aside from attribution and consumed as the answer to "does this monitor deliver anywhere?" — never reported as an unattributed alert.

**What the app writes:** Notifications, Insights monitors, and its own KV state. Nothing else — never Sources, Destinations, pipelines, routes, notification targets, notification policies, or Insights settings. The app creates alerts; it does not delete them, including its own, so no DELETE is granted anywhere. `/notifications` is granted GET and POST and has **no item path at all**; `/m/:gid/alert/monitors/*` is granted PATCH alone, and **only** as the recovery when a POST is rejected because that id already exists — never as a blind first move, which would overwrite an object this app did not create.

**Discover, do not hardcode:** Notification condition ids and their `conf` schemas, the per-feed monitor tag label, the monitor host group, and the monitor query. All four come from the API at runtime so the app survives version differences — and in the monitor's case because a guess would produce an alert that silently never fires.

**External integrations:** none. `config/proxies.yml` stays empty; the app holds no third-party secrets.

## State (app-scoped KV store only)

Never use `localStorage`, `sessionStorage`, `IndexedDB`, or cookies — the sandboxed iframe makes them unreliable. Values are written as serialized strings per the Cribl Apps KV guidance; reads accept both a string and a raw object, because values written by an earlier build are still out there.

- `cc-simplified-alerting/managed/{notification|monitor}/{id}` — registry of alerts this app created (group, feed id, direction, signal, and the template settings, which record the `mechanism` and, for a monitor, its `hostGroup`, `templateId` and bridge id). It is what lets the coverage column distinguish "created here" from "unmanaged" without inferring ownership from names. Keyed on the created object's id, so a monitor entry is keyed on the monitor id, not the bridge's. When there is no entry, ownership falls back to a marker the app wrote into the object itself — the reserved `csa-` id namespace for a Notification, `APP_MONITOR_MARK` in the `description` for a monitor — never to a name that looks familiar.
  - **The path segment is the mechanism, and it has to be.** `alertId` and `monitorId` deliberately produce the *same* string for a feed — the two objects live in different Cribl collections — so a single path would let a monitor record overwrite the Notification record for the same feed and lose which mechanism and host group were used. `loadRegistry` lists both prefixes; `notification` is unchanged, so records written before monitors existed still read back.
  - **This is a cache, not the truth.** On load, reconcile against the live reads: drop entries whose object no longer exists, and count unregistered alerts toward coverage as "unmanaged." A stale entry must never make an unwatched feed look watched.
  - **Reconcile each mechanism against its own read.** The live id set must include the monitor ids as well as the Notification ids, or every monitor entry is judged stale and deleted on the next load. When no monitor host answered at all, monitor entries are **not judged** — an unreadable collection is not evidence the object is gone.
- `cc-simplified-alerting/template-defaults` — last-used mechanism, condition and `conf`, and monitor settings, all **per direction**, plus routing. Per direction because the two directions land on different conditions with different fields *and* on different shipped monitor queries, so one shared setting would carry a field the other side does not declare. A saved mechanism or `templateId` that is no longer usable falls back rather than blocking every row.
  - **Routing is deliberately not per direction**, because it is not a property of what is being watched: the objects delivered are the same kind either way, and an admin who wants alerts in Slack wants both directions there. It is stored as `routingMode`, `notificationTargets`, `notificationTemplateByTarget` and `notificationRecipient` (the email address, written onto each monitor as `params.to` — not a secret, but personal data, and stored only so an admin does not retype it every run), and `coerceRouting` validates every value against the live reads — a deleted target, or a template that no longer matches its target's `type`, falls out rather than being sent. The old key keeps its name and meaning: **a stored target list with no stored mode reads back as `targets`**, because for a build that predates the choice that list *was* the decision, and restoring it as policy would silently move the admin's alerts off the targets they picked.

View preferences are deliberately **not** persisted — they live in component state and the URL.

## Write Safety

Per `AGENTS.md`, writes to customer configuration are volatile and require confirmation:

- Creation happens only after the admin confirms an explicit preview listing every object that will be written — for a monitor, **both** of them. Never create on render, mount, or a timer.
- Report per-item outcomes honestly. Bulk apply will partially fail; surface which items failed and let the admin retry them without reconfiguring. Do not swallow errors. When an alert is created but its registry entry is not, say both things. When a monitor lands but its bridge does not, say that too: it is `partial`, the item reads "created, not routed", and the sentence states that the monitor will appear and fire on the Insights page but delivers nothing.
- A write denied with 401/403 mid-run blocks every remaining item **of that mechanism** with that reason. Track denial per mechanism: the other mechanism may be perfectly permitted, and collapsing them would report a creatable alert as blocked.

## UI Structure

- **Table-first with a bulk-apply drawer.** One dense coverage table is the home screen; selecting rows opens a side drawer for configure → preview → confirm. No page navigation between finding gaps and fixing them.
- Sources and Destinations get their own section, each with an "N unwatched" count.
- Header: worker-group selector, direction filter, "uncovered only" and "unhealthy only" filters, search, coverage summary.
- Health cell expands to lazily fetch and show per-Worker-Process `healthCounts`; `status.error` gets its own always-visible indicator, not just an expanded detail, because a feed can be Green *and* carry an error.
- **One coverage column**, because there is one question: is anything watching this feed for a delivery stop? Both mechanisms answer it, so both appear in the same column; the chip names the mechanism rather than the column splitting in two. Alert chips are buttons that open the configuration view.
- **The mechanism is a per-direction choice in the drawer, and only appears when there is a choice.** One mechanism usable → no selector, and a notice saying which one and why. Neither → nothing is creatable, said once.
- Sticky action bar when rows are selected; inline per-item results after apply, each with the created object(s). A monitor whose bridge failed reads "created, not routed" with a warning appearance, never a plain success.
- React Router with `basename={window.CRIBL_BASE_PATH}`; filters and group selection in the URL.
- **Capra design system** (`@capra/core`, `@capra/icons`, `@capra/theme`) — see https://capra.cribl.io/llms.txt. Use design tokens via the `token()` function, never raw CSS variables. **Verify a token exists before using it** — `spacing.xxs` and `radius.sm` do not; the postcss plugin passes an unknown token through as invalid CSS and the browser silently drops the declaration. Valid spacing is `none|xs|sm|md|lg|xl|2xl`; valid radius is `md|lg|xl|full`. Do not put CSS classes on Capra components (use wrappers for spacing) or write selectors against Capra internals.
- `Text` has no `-bold` variants — use `body-sm-semibold`. There is no `Heading` export. `Pill` children are typed `ReactNode & string`, so wrap numbers in `String()`.
- Health uses Capra semantic status tokens so `Green`/`Yellow`/`Red`/`Unknown` read correctly in both themes and match how Cribl colours health elsewhere.
- An unhealthy feed with nothing watching it should be the first thing the eye lands on.

## Graceful Degradation

Each capability fails independently; never blank the page. **One notice per distinct problem, not one per affected capability** — a stack of alerts nobody reads is worse than one that lands. Derive severity from whether alerting is *entirely* impossible rather than defaulting to `warning`, and do not report the downstream consequences of a blocked route at all. What must never be collapsed away is a capability the admin would otherwise assume is working.

There are four capabilities: `alerting`, `monitors`, `routingTargets`, `registry`. Only `alerting` and `monitors` can block a write, and they do so independently — each blocks items of its own mechanism and nothing else.

- Notification write denied → no Notification is creatable; every Notification item is blocked with the reason. If monitors are available the drawer offers them instead rather than rendering the whole app read-only.
- `GET /conditions` denied → `alerting` is unavailable, because condition ids are never guessed. There is no fallback route; say so plainly.
- `GET /conditions` readable but offering nothing for one direction → not a capability failure, half the app works. Emit one up-front notice naming the direction that cannot be alerted on, so an admin who selects it does not find every row blocked without explanation.
- No group's `/m/{gid}/alert/monitors` answers, or none holds a shipped Stream monitor to copy a query from → `monitors` is unavailable and Notifications carry the app. Name the path and the prefix that was tried.
- Both mechanisms unavailable → nothing is creatable and the table renders as a read-only coverage and health audit. That is the only state that earns `danger`.
- Insights unhealthy on the monitor host group, or its healthcheck unreadable → **the monitor mechanism only**, folded into the `monitors` capability. A `red` engine blocks monitor creation outright rather than reporting a monitor that would never be evaluated; an unreadable healthcheck is a notice, not a block, because it is not evidence of a dead engine. No Notification depends on a metric name or an engine, so this never blocks a Notification write.
- Status endpoints denied → the `healthCounts` breakdown on row expand reads "unavailable"; the base health column is unaffected because it comes inline from the discovery call.
- Notification targets denied → **only the `targets` route is lost, for both mechanisms.** Alerts stay creatable by policy, and the drawer says once that routing by target is unavailable and must be attached in Cribl separately. The drawer also warns when the admin picks the targets route and then leaves it empty: an alert with no targets fires but notifies nowhere.
- Notification templates unreadable → targets are still offered, untemplated, each rendered with its own default. Said inline beside the template pickers, not as a page notice.
- The policy count unreadable → the drawer says the policy route could not be checked. A count of **zero** is a different thing and gets the harder treatment, because it is a fact: it flips the *default* to the targets route, it is repeated on the preview, and it is stated on any existing alert's configuration view. Neither blocks a write — a policy the app cannot see may still exist, a policy the admin is about to create does not exist yet, and refusing to create an alert over a routing choice would be worse than creating one the admin was warned about three times.
- An smtp target chosen with no recipient → warned, not blocked, in the drawer and again on the preview. The address is written to the monitor's `params.to`; a condition Notification cannot carry one at all, which is said rather than worked around.
- Registry unreadable or unwritable → coverage still works off the live read; alerts show as "unmanaged" rather than "created by this app". An alert created whose registry write failed says so per item.
- One worker group denied → skip it with a note; other groups render normally.

No app-level access filtering: render what the API returns and let Cribl RBAC and worker-group ACLs be the single source of truth.

## MVP Scope

**Must-have (Phase 1):** worker-group discovery filtered to `type === 'stream'`; Source/Destination discovery filtered to `disabled !== true`; correct `type` + `id` → `type:id` metric-dimension join; runtime discovery of Notification conditions with schema-driven forms per direction; monitor host discovery by probe with shipped-query templates per direction; coverage table with health, a separate error indicator, and one coverage column carrying both mechanisms; group/direction/uncovered/unhealthy/has-an-error filters; multi-select with "select all uncovered"; bulk-apply drawer with a per-direction mechanism choice and a routing choice between a notification policy and targets-with-a-template; mandatory preview showing every object to be written; sequential creation with progress, per-item results including partial success, the created object, and retry; click-through configuration view for any attributed alert of either mechanism; KV registry and template defaults with per-mechanism reconciliation; graceful degradation.

**Nice-to-have (defer):** per-alert tuning editor (highest value); drift banner; firing-history view; **alerting on `status.error` presence** to close the Green-with-error blind spot; `backpressure-dest` and `persistent-queue-usage*` alerting (both confirmed present in the catalogue, so cheap — they are classified `unclassified` today and shown but not counted); alerting on the per-type source metrics the discovery call already returns (`broken` / `activeBreakers`, `numErrors` / `numDropped`); separating `Yellow` from `Red` as distinct severities; baseline-suggested thresholds; bulk disable/delete; Edge fleets; config export.

**Out of scope:** evaluating alerts in-app; an alerting engine of the app's own, or a third mechanism beyond the two Cribl objects; composing PromQL; creating notification policies; **defining a custom health model** (consume the platform's verdict as-is); sending notifications; creating/editing notification targets or policies; authoring new conditions; modifying Sources, Destinations, pipelines, or routes; changing Insights settings; replacing Cribl's alerting UI; root-cause analysis; Edge/Search/Lake coverage; non-admin personas.

## Additional Guidance

- Read the [Cribl Apps Builder Guide](https://docs.cribl.io/apps/builder-guide/) for patterns and best practices
- Run `/app-brief` to generate the implementation guide, `/app-validate` to check it against this definition, and `/app-implement` to build
- Declare every Cribl API path the app calls in `config/policies.yml`, including the `/m/:gid/...` variants
- Verify with `npx tsc -b`, `npm test`, `npm run lint`, `npm run build`. Tests run on Node's native type stripping (`node --test`) with zero extra deps, so imports carry explicit `.ts` / `.tsx` extensions.
