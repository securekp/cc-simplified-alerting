# App Definition

## App ID

`cc-simplified-alerting`

Display name: **Simplified Alerting**. Renamed from `ally-monitoring`; `package.json` `name` and `displayName` carry the new identity.

The rename has two consequences that are handled in code rather than left as caveats, because both would otherwise show up on the coverage table as an alert this app created disowning itself:

* **The KV store is app-scoped by app id**, so `/kvstore/{key}` now resolves under a different app and the old registry is unreachable. Nothing is migrated and no fallback read is attempted — the registry is a cache, coverage is read live, and the two markers below cover the alerts it forgot.
* **The reserved id namespace moved to `csa-`, and `ally-` is still accepted**; likewise `APP_MONITOR_MARK` is the new sentence and the old one is still recognised. For a monitor the mark is the *only* authorship evidence there is, so dropping it would relabel every pre-rename monitor as not created by this app.

## Problem

Cribl already has everything needed to alert per Source and per Destination — health status on every input and output, Insights throughput telemetry, and a Notification engine that fires on per-feed conditions. What it does not have is a fast path from "here are my enabled Sources and Destinations" to "each one is watched." Today an admin must hand-author each alert in the Cribl UI, look up the right condition for every feed and direction, and repeat all of it every time a source or destination is added. In practice this doesn't happen, so the deployment runs with no per-feed alerting at all.

The app closes that gap. It auto-discovers which Sources and Destinations are actually enabled on the platform, shows which of them are already watched, and lets the admin create per-source / per-destination alerts from a template in a few clicks.

**There is one failure mode the app alerts on: the feed is no longer delivering data.** That is the question an admin actually needs answered, and the one whose answer is actionable. The evidence differs by direction — a Source proves a stop through its data volume (`no-data`, `low-volume`), a Destination through the platform's own health verdict (`unhealthy-dest`) — but the intent is single, so the admin states it once and the app resolves the condition per direction.

**Health is shown, not alerted on.** Every input and output reports `health` as `Green` / `Yellow` / `Red` / `Unknown`, aggregated across all Worker Processes, alongside a `healthCounts` breakdown and an `error` object. All of that is surfaced in the coverage table — a Red Source is visible at a glance, and `status.error` gets its own column because a feed can be Green *and* carry an error. What the app does not do is author a separate health alert: the condition catalogue offers no Source health condition, and the monitor mechanism copies only the shipped *throughput* queries, so neither mechanism can express one without the app composing PromQL — which it does not do (see Architecture Decision 2). Seeing health in the table, plus one alert per feed that catches a delivery stop, is the scope the admin asked for.

## Target Users

**Primary: Cribl platform admins.** The people who own the Stream deployment, configure the Sources and Destinations, and are accountable for whether data is still flowing end to end. They have admin-level access to the Cribl API, can see all worker groups, and are the ones who would otherwise be hand-building alerts.

They are the only user role the app needs to serve for MVP. Ops/on-call engineers and data owners are *consumers* of the alerts the admin creates, not users of this app — they receive alerts through whatever notification target the admin attaches, and never need to open the app.

## Current Situation (Before This App)

**Nothing — reactive discovery.** There is no per-source or per-destination alerting in place today. Drop-offs and connectivity failures are found out after the fact, usually when a downstream consumer notices missing data and complains. There is no existing process, spreadsheet, or external tool to migrate away from, which means:

* The app does not need an import/migration path from a prior system.
* Any coverage the app creates is net-new value; the baseline is zero.
* Time-to-first-alert matters a lot — the admin should be able to go from install to a meaningful set of alerts in one sitting, without first learning which alerting mechanism to use, what the condition IDs are, or what the Insights metric names and label filters look like.

## Deployment Scope

**All Stream worker groups.** The app enumerates worker groups and discovers Sources and Destinations per group; alerts are created scoped to the group that owns the source or destination. Edge fleets are out of scope for MVP.

## Architecture Decision 1: The App Is an Authoring Tool, Never an Evaluator

The app generates alert configuration and writes it to Cribl. It does not evaluate anything itself.

This is decisive for the whole design. The app runs in a sandboxed iframe with no background runtime, so an app-owned alert engine would only evaluate while somebody had a browser tab open — useless for alerting. By delegating to Cribl's own engines:

* Alerts keep firing when the app is closed, uninstalled, or the tab is shut.
* They appear in Cribl's native alerting UI and history, so they are inspectable and manageable without the app.
* They reuse existing notification targets, policies, and silences.
* The app's value is entirely in *discovery, templating, bulk creation, and coverage visibility* — not in evaluation.

Non-negotiable consequence: no polling loops that check thresholds, no in-app rule engine, no timers that decide whether something is firing.

## Architecture Decision 2: Two Native Mechanisms, Both of Them Cribl's

The app writes alerts two ways, and the admin chooses **per direction** in the bulk template. Both are objects Cribl's own UI creates; neither is an engine the app invented, and there is no third.

| | Mechanism A — Notification | Mechanism B — Insights monitor |
|---|---|---|
| Write | `POST /notifications`, `condition` from `GET /conditions` | `POST /m/{gid}/alert/monitors` **plus** a bridge `POST /notifications` |
| Where it shows up | the Insights alerts page and the group's Notifications page, with no chart | the Insights alerts page, with a chart, an Activity trail, and its own edit screen at `/insights/alerts/monitors/edit/{id}` |
| Named | `csa-{group}-{feed}` | `{shipped monitor id}_{feed id}` — `event_volume_in_rate_ZscalerWeb` |
| Per-feed by | `conf.name` | `rules[0].includedTags` (`type:id`) |
| Threshold from | the condition's own JSON Schema | `rules[].conditions[].condition.threshold` |
| Routed by | the admin's choice, written onto this Notification | the admin's choice, written onto the bridge Notification |
| Needs | the condition catalogue | a group whose monitor collection answers, and a shipped query to copy |

### Why there are two, and why the second one is Mechanism B

An earlier revision specified two engines, then collapsed to Notifications alone because the monitor route had three unresolved problems:

1. **`/alert/monitors` returned an Express 404** on the verification org despite being documented in `openapi.json`.
2. **`MonitorConf.rules[]` had no publishable schema** — it is required and it is where the threshold lives, but the spec resolves it to `Rule.conditions[].condition` → `Condition` → `$ref: Function`, a pipeline-function schema, and the spec's own create example ships `rules: []`.
3. **Both monitor engines looked dead** — `SERVICE_DOWN_aetos` and `SERVICE_DOWN_lh_engine_metrics`, each "No workers registered".

A HAR capture of the org's **own Insights UI creating an alert** (finding 19) resolved 1 and 2 with direct evidence: the route exists under `/m/{gid}/`, and a real `rules[]` is in the capture. Problem 3 is answered by construction rather than by a probe — the host group is the one that actually answers *and* holds Cribl's shipped Stream monitors, and `/m/{gid}/system-insights/healthcheck` is read before the capability is offered.

Mechanism B was added because Mechanism A alone could not satisfy the requirement it was asked to: an alert that appears where an Insights alert appears, with a chart, thresholds, and an edit screen of its own. **It is now the default** — the drawer opens on it wherever it is usable — and Mechanism A is the fallback, kept because it needs nothing but the condition catalogue and is therefore the route most likely to work on any given deployment. A saved choice wins while it stays usable; a mechanism that has become unusable falls back rather than producing a drawer of blocked rows.

The rule that governed the collapse still governs the addition, and it is the important one: **the app must never report success for an alert that cannot fire.** Everything below about copied queries, discovered host groups and enabled thresholds is that rule applied.

### The four rules that keep a monitor from being a silent no-op

1. **The host group is discovered by probing, and it is not the feed's group.** Monitors were observed in `default_search` while the feeds live in `default`. Preference goes to a group holding shipped `isDefault` Stream monitors — evidence its engine is wired up — then to any group that answers. If none answers, the mechanism is unavailable and says which path and prefix were tried.
2. **The PromQL query is copied verbatim from a shipped monitor, never composed.** Shipped queries use underscore metric names and an empty-string namespace matcher (`rate(total_in_bytes{namespace=""}[5m])`) that the app cannot verify from inside a sandboxed iframe. A hand-authored expression matching no series produces a monitor that never fires — the worst outcome available. If no shipped monitor measures that direction's throughput, the item is **blocked with a reason**, not improvised. A template whose query is not a throughput query is refused for the same reason: it would be created and then never counted as coverage.
3. **Per-feed scope lives in `includedTags`, not in the query.** `{input: ["datagen:ZscalerWeb"]}` — exactly the `type:id` values the metric join already builds. Only the feed tag is pinned; adding a `__worker_group` tag the deployment may not support would narrow the monitor to nothing, and a monitor that is silently too broad is far less dangerous than one that is silently dead.
4. **One rule, one enabled condition.** Every monitor Cribl ships carries `enabled: true` on the object and `enabled: false` on all three severity thresholds. So coverage requires the monitor enabled **and** at least one condition enabled, and a created monitor carries exactly one threshold — the thing an admin can reason about and later tune.

### The monitor's name, and the two things it costs

A monitor is named **`{shipped monitor id}_{feed id}`** — `event_volume_in_rate_ZscalerWeb` — and `name` is set to the same string as `id`, so the row on the Insights alerts page and the URL it links to read alike. Named after the metric it copies rather than after this app, because that is what an admin scans an Insights alerts list by. Sanitised to Cribl's id character set and capped at 100 characters.

That drops the old `csa-{group}-{feed}` form, which was carrying two jobs. Both are replaced in code, not accepted as a caution:

* **Authorship.** The id no longer proves this app minted the object, so `buildMonitor` writes a fixed marker sentence at the head of `description` and ownership treats it as the same class of evidence the id namespace was — a string the app generated, not user prose being pattern-matched. `ally-` ids are still accepted, so monitors from earlier builds keep reading as app-created. The worker group goes into that same description, since the id no longer carries it.
* **Uniqueness.** Two feeds of the same name in different worker groups now produce the *same* monitor id. Creating both is refused: **an id two different feeds would share blocks both items** and names the clash, because the create path PATCHes on an id-exists rejection and would otherwise silently retarget the first feed's monitor at the second — leaving a feed that reads as watched by a monitor scoped to something else. Note the two hazards are graded differently: a feed **tag** shared across groups is a *warning* (the monitor works, it simply watches both feeds), while a shared **id** is a *block*.

### The two mechanisms fail independently

`alerting` and `monitors` are separate capabilities with separate reasons to fail, and each blocks only items of its own mechanism. A monitor is **not** gated on `alerting`: `alerting` reflects whether the condition catalogue is readable, and a monitor's bridge uses the fixed `monitor-alerts` condition, which consults no catalogue. Whether the bridge write is permitted is only knowable by attempting it, so a bridge failure is reported per item as a partial success — the monitor exists and will fire on the Insights page, and nothing is delivered from it — and never predicted by blocking the item up front.

### The catalogue is asymmetric, and the condition is chosen per direction

Read live on 2026-09-02. This asymmetry is real and permanent-looking, and it is the reason the condition is resolved per direction rather than fixed in app code:

| Direction | Condition offered | Signal it watches |
|---|---|---|
| Source | `no-data`, `low-volume`, `high-volume` | volume |
| Destination | `unhealthy-dest` | health |

Both satisfy the one intent — "this feed is no longer delivering data" — so the admin picks the intent and the app picks the condition. A Destination proving delivery through `unhealthy-dest` is exactly as covered as a Source proving it through `no-data`. **Requiring both signals per feed would mark every feed on a real deployment uncovered**, because neither direction offers both.

The `Signal` label (`health` / `volume` / `unclassified`) therefore exists to tell the admin *what* a condition watches. **It is not a routing decision.**

### Why Mechanism A is still worth keeping

* It consumes the platform's own verdict, so the app's definition of a problem matches the definition the Cribl UI shows. There is no second, subtly different model to drift out of sync.
* `timeWindow` gives the sustained-state requirement for free — no flapping on a single bad scrape.
* `notifyOnResolution` gives recovery notifications, so on-call learns when a feed comes back.
* It is per-feed by construction: `conf.name` targets one Source or Destination by id.
* `group` scopes it to a worker group, so a same-named feed elsewhere is not swept in.
* **It needs nothing else to be working.** No Insights metric name to discover, no `type:id` label join to get right, no monitor engine, no notification policy. That is what makes it the fallback: on a deployment where the monitor collection does not answer, or where no shipped monitor measures a direction's throughput, Mechanism A still creates a working alert.

What it cannot do is the reason it is no longer the default: a condition Notification has no chart, no threshold history, and no edit screen of its own on the Insights alerts page. It is *listed* there (finding 19 shows that page reading `/notifications` alongside the monitor collection), which is why its configuration view links there first — but there is nothing to click through to, and the view says so rather than implying a screen that does not exist.

### Conditions are discovered, never hardcoded

The app calls `GET /conditions?category=sources` and `GET /conditions?category=destinations` to enumerate what the deployment actually supports. Each condition returns a JSON Schema describing its `conf` fields, complete with titles, descriptions, patterns, and duration minimums — so the app renders its configuration form *from that schema*, and prunes the template's `conf` against it before sending. A new or renamed condition in a future Cribl version shows up automatically instead of breaking the app. A condition id is never fabricated: if a direction offers nothing, the app says so and creates nothing for it.

`GET /conditions` takes `category`, `showHidden`, `offset`, and `limit`, and returns a `PaginatedConditionResponse`. Hidden conditions are **excluded by default**; the app decides `showHidden` deliberately rather than by omission.

**Classification is by what a condition watches, never by its `type`.** Six of the ten live conditions are `type: "metric"`, including `backpressure-dest` and both `persistent-queue-usage*`, which watch neither delivery volume nor feed health. A `type`-based rule would file those as coverage and mark a feed watched for a delivery stop nobody is watching. The app matches on the id/name (`health`; `no-data|volume|byte|event|throughput|rate`) and returns `unclassified` otherwise. Unclassified alerts that attribute to a feed are still shown in its coverage cell — under "Also on this feed, but not watching for a delivery stop" — so nothing is hidden, but they never count.

### Per-direction `conf`, kept separate

`no-data` declares `dataVolume`-style fields that `unhealthy-dest` does not, and both declare `timeWindow`. The template therefore stores and validates `conf` **per direction**, and the two error bags are deliberately not merged: a merged bag would report a Source error against a Destination field, or mask one with the other.

**`conf.name` is pinned to the feed, always.** Cribl's own `uischema` renders it `ui:disabled: true` with `default: "${IO_ID}"`. The template must never supply or override it; it is applied last when building the payload, so a template-supplied `name` cannot hijack an entire bulk run onto one feed.

### What Insights is still for, and what was removed from it

**There is no throughput-history column and no metric query. Removed 2026-09-02, deliberately.** An earlier build read `POST /insights/metrics/query` (plus `/system-insights/metrics*` and `/system/settings/insights`) to draw a per-feed sparkline. Real-time throughput is what Cribl Insights itself is for, and a 96-pixel history of it duplicated that view badly while carrying the app's most fragile dependency — two competing metric-name conventions, neither verifiable from the browser. **Do not reintroduce a metric-history read for display purposes**, and do not restore the `insights` capability: what it absorbed no longer exists.

Removing all of it cost **no alerting capability whatsoever**, which is the proof of the rule that made it safe: **no Notification depends on a metric name.** Insights can be denied, disabled, unhealthy, or absent without costing a single Mechanism A write. Never gate a Notification on Insights.

A monitor does depend on Insights — that is what it is — but not on a metric *name* the app chose: it inherits the metric through a copied query. The one Insights call left in the app is `GET /m/{hostGroup}/system-insights/healthcheck`, folded into the `monitors` capability, and it exists for exactly one decision: refusing to create a monitor in a group where nothing would evaluate it.

### Facts retained from the monitor investigation

These are live-verified and remain true. Some the monitor mechanism now depends on directly; the rest no code reads, because the mechanism authors on a copied query rather than on a metric the app names. Keep all of them, so any future work here starts from evidence rather than repeating the same probing.

* **`health != 0`, never `health == 2`.** The metrics `health.inputs` (dimension `input`) and `health.outputs` (dimension `output`) exist per feed and read `0` = `Green`, `2` = `Red`, cross-checked on two independent feeds whose `status.health` read `"Red"`. `Yellow` and `Unknown` are unnumbered by observation, so any health rule must be expressed as `!= 0` to be correct regardless of how the remaining states are numbered.
* Query metric series with **`POST /system/metrics/query`**. `GET /system/metrics` is a different, GET-only endpoint; `POST /system/metrics/enum` enumerates dimension values.
* **A GET probe proves nothing about a POST-only route** — Express returns `Cannot GET` for those too.
* **A root 404 proves nothing about a group-prefixed route.** This is the mistake that cost the monitor mechanism a whole revision: `/alert/monitors` 404s at the root and answers under `/m/{gid}/`, and `/system-insights/*` behaves the same way. Probe both forms before concluding a route is absent.
* **Monitor PromQL uses underscore metric names and an empty-string namespace matcher** — `rate(total_in_bytes{namespace=""}[5m])` — which is *not* the dot-separated form `POST /insights/metrics/query` accepts. Two name conventions live in one product, and the app cannot verify from inside the browser which one the monitor engine resolves. This is the single strongest reason the query is copied verbatim rather than composed.
* **`openapi.json` is not evidence about this route.** `MonitorConf` there has no `type` / `detectionConfig` field and its `rules[]` has no usable schema, yet the live objects carry well-formed `rules[]` — the spec was simply behind. So percent-drop, anomaly, forecast, outlier, and change detection are deferred behind **not having captured a real monitor that does one**, not behind the spec's silence. (`MonitorType` and `ChangeConfig` do exist in the spec, but belong to `AetosMonitorConf`, used only by `/products/lakehouse_engine_metrics/monitors` — a different endpoint with a different schema, empty on the verification org and backed by a dead engine.)

### What this means for the UI

The admin states an intent and picks a mechanism per direction; the app resolves everything else — the condition, or the host group and the query. Nothing about the result is hidden: every alert chip in the coverage table opens a configuration view built from the **stored object** as Cribl returned it. For a Notification each `conf` field is labelled from the condition's own schema and any undeclared key is listed rather than dropped. For a monitor the fields are named in the component, since no schema for one exists, and the three things that decide whether it can fire are all shown in full — the query, the feed tags, and each threshold with its own `enabled` state ("switched off — cannot fire").

The apply results step shows the created object(s) inline for the same reason — the admin should not have to close the drawer and hunt for an alert by id to see what they just made.

Every view and every apply result also links **out** to the object in the native Cribl UI, and the link is per object where one exists: a monitor goes to its own edit screen, `/insights/alerts/monitors/edit/{id}`, which is where an admin tunes a threshold. A Notification has no such screen, so it leads with `/insights/alerts/activity` — the page that lists it — says it carries no chart there, and offers the group's Notifications page as the screen it is actually edited on. **A deep link is only ever built from a route observed live**; a guessed URL that 404s is worse than an extra click. Each view states plainly that this app creates alerts and never edits them.

**The mechanism selector only appears when there is a choice.** If only one mechanism is usable, there is no selector and one notice says which one and why. If neither is, nothing is creatable and the table is a read-only coverage and health audit.

**Scope does not remove the choice.** It did while a Pack feed could only be a Notification, which forced a monitor form and a condition form onto the screen at once and made the two scopes read as different features. They are not: a Pack feed takes whichever mechanism its direction is set to, so there is one selector and one form per direction. A direction holding Pack feeds says so in a line of subtext — the alert is written into the Pack, or the monitor is scoped to the Pack-qualified tag — because where an object lands is worth knowing before it is created, but it is not a second decision.

## Architecture Decision 3: Where an Alert Is Delivered Is the Admin's Choice, Not the Mechanism's

The app used to decide routing by mechanism: a Notification named `targets`, a monitor's bridge carried `mode: "policy"`. That was a faithful copy of what the platform's own UI does, and on the verification org it produced an alert that reached nobody — `GET /notification-policies` answers `{"items":[],"count":0}` there, so "routed by policy" meant "routed nowhere". **Routing is now an explicit choice in the drawer, and it is the same choice for both mechanisms**, because the object being routed is the same kind of object either way: a Notification.

`Notification.mode` is `enum: ["direct", "policy"]` with a three-branch `oneOf`, and the app offers exactly the two routes that enum names — never a third, and never a shape the schema does not have a branch for:

* **Policy** — `{"mode": "policy", "targets": [], "templateTargetPairs": []}`, copied field for field from the capture. The alert names nothing and a notification **policy** decides where it goes. This is the **default**, because it is what the platform's own client posts on create and because a monitor is the default mechanism — but only where a policy could carry the alert. See "Policy is the default only where a policy exists" below.
* **Targets** — the alert names notification target ids directly, optionally with a **template** per target so the message is rendered for that target's type.

**Both shapes are now observed on the wire, and the second is observed as a repair.** A HAR of this org's own Insights UI (2026-09-02, evening) shows a bridge created `mode: "policy"` on a deployment with zero policies — delivering nothing — and then changed to `{"mode": "direct", "targets": [], "templateTargetPairs": [{"targetId": "system_email", "templateId": "default-email"}]}` → 200. That single capture settles three things this decision previously had to reason about: `direct` is real, a templated target is named **only** inside its pair, and policy on a policy-less deployment is a state Cribl's own users hit and have to undo by hand.

Four rules keep the choice from breaking a path that is already proven:

1. **A templated target lives inside its pair and nowhere else.** Every selected target templated → `targets: []` with the pairs, exactly the captured repair. An earlier build of this app listed a templated target in `targets` *and* in its pair; that shape has never been seen from Cribl and risks either a duplicate send or a silently ignored field.
2. **Targets with no template collapse to a bare `targets: [...]`** — the third `oneOf` branch, which allows `mode` to be absent, and byte-for-byte the shape every alert this app created before the choice existed. No `mode` is invented to fill the gap, because the `direct` branch requires `templateTargetPairs` with `minItems: 1`. A **mixed** selection splits: pairs for the templated targets, `targets` for the rest, so no target is ever named twice.
3. **A template pairs with a target of the same `type`.** `default-email` renders `smtp`. A target with no matching template is normal rather than broken — the deployment's own `system_notifications` is `bulletin_message` and no template ships for it — so the template is optional per target. A template whose `type` could not be read is offered anyway: an unreadable field is not evidence of a mismatch, and hiding a template the admin can see in Cribl would be the worse error.
4. **An email recipient is not a routing field, and it is not optional either.** `default-email` renders `"to": "{{metadata.to}}"`, and `system_email` carries no address of its own — that target reported `errorCnt: 1` while the recipient was missing. The same capture shows the address arriving on the **monitor** as `params.to`: `{"to": "kprior@cribl.io", "unit": "none"}`, the only field that changed between the two HARs and present on none of the other 40 monitors. So the recipient travels with the delivery choice, is applied by the monitor builder over the copied `params`, and is never written onto a Notification. **A condition Notification has no `params` and therefore cannot carry a recipient at all** — a real limit of Mechanism A with an smtp target, stated in the drawer rather than papered over.

**Policy is the default only where a policy exists.** Where `GET /notification-policies` counts **zero**, the drawer opens on the targets route instead, because policy there is the one route known to deliver nothing. That is not the app choosing delivery: **no target is ever preselected**, so the admin still has to name one, and the drawer says why the default moved. A *stored* choice of policy still stands and is warned about rather than overridden — the admin may be about to create the policy. An unreadable count (`null`) is not zero and keeps the policy default.

**"Delivers nowhere" is said wherever it is provable, and only there.** Three places, because a single drawer notice demonstrably was not enough — four alerts were created into exactly that state with the warning on screen: the Delivery section of the drawer, the **mandatory preview** the admin has to confirm, and the configuration view of an existing alert, which is the only screen that combines a stored `mode` with the live policy count. The read-back still refuses to claim either way for policy mode in general — *which* policy matches an alert lives in an object this app does not read — but a **count of zero** is a fact, not a matching question.

**The app still creates none of the three routing objects.** Targets, templates and policies are read-only inputs: `GET /notification-targets`, `GET /notification-templates?engine=handlebars`, and `GET /notification-policies` **for its count alone** — the app never needs a policy id, only the answer to "is there any policy at all?", because a policy-routed alert on a deployment with none delivers nothing and that is worth saying before anything is written.

**Neither read is a new capability.** There are still four (`alerting`, `monitors`, `routingTargets`, `registry`), and neither of these reads can cost the admin an alert. Templates unreadable → targets are still offered, untemplated. The policy count unreadable → the drawer says it could not be checked, rather than claiming there are none: a policy the app cannot see may still exist, and refusing to write over a read failure would be worse than writing something the admin was warned about. A count of **zero** is a different thing, because it is a fact, and gets the harder warning with the targets route named as the alternative. Both are stated inline in the drawer beside the choice they affect, never as a page-level banner.

**Routing is stored per run, not per direction.** Everything else in the template is per direction, because the two directions land on different conditions and different queries; routing is not a property of what is being watched, and an admin who wants alerts in Slack wants both directions there. Four values are kept: the route, the selected targets, the template chosen per target, and the email recipient — the last only so an admin does not retype an address on every run. It is personal data rather than a secret, which is why it is stored in the clear and why it is the one routing value that ends up on a monitor rather than on a Notification. On load, every stored value is validated against the live reads — a deleted target, or a template that no longer matches its target's `type`, falls out rather than being sent. The one migration: a stored target list with **no** stored mode reads back as the *targets* route, because for a build that predates this choice that list was the decision, and restoring it as policy would silently move an admin's alerts off the targets they picked.

**The configuration view reads routing from the stored object, never from the template that produced it** — for a monitor, from the *bridge*, because that is where the route lives. Now that routing is a choice, a screen whose whole purpose is answering "what is really there" cannot answer it by repeating the assumption the app was built with. **And it reads delivery from `targets` *and* the pairs, never from `targets` alone:** a `mode: "direct"` object has `targets: []`, so reading only that field reported the one alert Cribl itself had repaired as "nothing is sent" — the worst direction for this screen to err in, because it sends an admin to re-fix a working alert.

## Verified Against a Live Deployment

The following was confirmed empirically against a real Cribl Cloud org, not inferred from the API spec. These findings are load-bearing for the implementation.

Findings 1–6 were established in the first pass and **re-verified on 2026-09-01**. Findings 7–12 come from that second pass, which queried the metric store directly and therefore corrects some metric naming the first pass had assumed.

### 1. Health is embedded directly in the config discovery calls

`GET /m/:gid/system/inputs` and `GET /m/:gid/system/outputs` return `status.health` inline as a **string** (`"Green"` / `"Red"` / …), along with a `timestamp`, a per-type `metrics` object, and — on Destinations — an `error` object when applicable. Observed source metrics vary by type and are genuinely useful: `activeSockets`, `received`, `broken`, `activeBreakers` (TCP/Splunk), `numInProgress`, `numEventProcessors` (HTTP), `numRequests`, `numErrors`, `numDropped` (OTel), `buffered`, `dropped`, `received` (Cribl internal), `eventCount` (datagen).

**Implication:** the coverage table's core content — name, type, enabled state, and current health — comes from **one call per group per direction**. The separate `/system/status/inputs|outputs` endpoints are only needed for the `healthCounts` per-Worker-Process breakdown, which makes them a progressive enhancement rather than a requirement. This meaningfully reduces the number of calls on first paint.

### 2. Health value mapping in the metric store is proven

`health.inputs` (dimension `input`) and `health.outputs` (dimension `output`) both exist and return per-feed series. Cross-referencing the metric values against the health strings from the config calls on the same org gives an unambiguous mapping:

| Feed | `status.health` string | `health.*` metric value |
|---|---|---|
| `in_cribl_tcp` / `cribl_tcp:in_cribl_tcp` | `Red` | `2` |
| `in_splunk_hec` / `splunk_hec:in_splunk_hec` | `Red` | `2` |
| `kptest_stream` / `cribl_http:kptest_stream` (outputs) | `Red` | `2` |
| all others observed | `Green` | `0` |

**`0` = Green and `2` = Red, confirmed by three independent matches across both directions.** `1` (presumably Yellow) and the Unknown value were not observed on this org.

Re-verified on 2026-09-01 with `max("health.inputs")` split by `input` and `max("health.outputs")` split by `output`: the same two Sources still read `2`, one Destination read `2`, and every other feed read `0`. `max()` is the correct aggregation — the roll-up series across all feeds also returned `2`, i.e. the worst state wins, which is exactly the semantics a per-feed filter then narrows.

**Implication at the time:** the health-alert rule had to be expressed as **`health != 0`** rather than `health == 2`, so it did not depend on a mapping that had not been fully observed and so it caught degraded and unknown states as well as critical ones.

**Implication now:** nothing in the app reads this metric — the health column comes inline from the config call as a *string*, and no alert is authored on a metric (Architecture Decision 2). The mapping is retained as the answer to the obvious future question, along with the rule that goes with it: **`!= 0`, never `== 2`**, because two of the four states have never been observed as numbers. The same caution applies to the string form the app does use — `Unknown` and an absent `status` are both "not known to be healthy", never "healthy".

Metric dimension values are fully-qualified `type:id` strings — `syslog:in_syslog:udp`, `splunk_hec:in_splunk_hec`, `cribl_lake:palo_traffic`, `cribl_http:kptest_stream` — while the config calls key on the bare `id` (`in_splunk_hec`). **The app must construct the qualified dimension value from the config object's `type` and `id` and match it exactly, never parse the dimension value back into parts.** Findings 8 and 9 below give the three concrete ways parsing goes wrong. Getting this join wrong is the most likely source of silently mismatched coverage.

### 3. Health can be Green while an error is present — a real blind spot

Three Destinations on the test org (`dd_test`, `ngrok_test`, `dynatrace_test`) reported `status.health: "Green"` while simultaneously carrying:

```
status.error.message = "There is an issue with the underlying destinations. Check cribl.log for more info."
```

**Implication:** an alert on health alone would not fire for these. This is a genuine limitation of the health signal, not of the app, and it is one of the reasons health is a display column rather than an alerting intent. The honest response is to make it visible rather than paper over it:

* The coverage table surfaces `status.error` as its own indicator, independent of the health cell, so a Green-with-error feed is visibly not-fine.
* The app does not silently redefine health to include the error, because that would put the app's verdict at odds with the Cribl UI's — the thing this design explicitly avoids.
* Erroring-but-Green feeds are a strong argument for not treating health as the only signal — the delivery-stop alert is what catches the consequence.
* Alerting on `status.error` presence is a candidate for the deferred list, since it needs a mechanism that can evaluate it server-side.

### 4. The monitor engine can be down independently

The test org reported `Service down - aetos` — "The service failed to boot due to: No workers registered". Aetos is the alert-monitor service (the spec's `AetosMonitorConf` / `AetosMonitorQuery` schemas confirm the naming). `lh_engine_metrics` was also down.

**Implication at the time:** an org can have a working Notification engine and a dead monitor engine, so the app had to check `GET /health` and `GET /system/messages` and warn before creating a monitor, rather than reporting a success for an alert that could never fire.

**Implication now — the gate is back, because the monitors are.** The requirement this finding created was right and it has been reinstated in a form the browser can actually act on: before offering Mechanism B the app reads `GET /m/{hostGroup}/system-insights/healthcheck`, and it prefers a host group that demonstrably already holds Cribl's own working monitors. A `red` status disables monitor creation rather than reporting it as working; a healthcheck that cannot be read leaves monitors creatable with a notice that nothing can be confirmed to evaluate them.

What is *not* reinstated is the root-level `GET /health` and `GET /system/messages` read. A `SERVICE_DOWN` message names a deployment-wide service the admin cannot act on from this app, and quoting one at them was part of the notice pile-up described under Permission-Denied Behavior. The group-scoped healthcheck answers the same question about the group the app is about to write to. **The principle is unchanged and is the load-bearing one: never report success for a monitor that cannot fire.**

Note the original write-up also cited `workerCount: 0` on the `default` group as corroborating evidence. §13 later disproved that reading: `workerCount` read `0` for a group that demonstrably had Workers. The service's own message was the only sound evidence here.

### 5. Worker group filtering cannot be trusted to the API parameter

Requesting Stream groups returned four groups, two of which had `type: "outpost"` rather than `type: "stream"`, alongside `default` (cloud) and `defaultHybrid` (`onPrem: true`).

**Implication:** the app must filter on `type === 'stream'` in its own code rather than relying on a product-type query parameter, or the coverage table will include groups the app has no business alerting on.

### 6. Disabled feeds still report health

`in_syslog_default` and several datagen sources have `disabled: true` yet still report `status.health: "Green"`.

**Implication:** the app filters on `disabled !== true` for coverage purposes, as already specified. Health alone is not evidence that a feed is in service, so it must never be used as the enabled test.

### 7. The throughput metric names are `total.in_bytes` / `total.out_bytes` / `total.in_events` / `total.out_events`

Queried directly against the live metric store on 2026-09-01. Dot-separated, no `cribl.` prefix, no `_total` suffix:

| Aggregation expression | Result over 1h |
|---|---|
| `sum("total.in_bytes")` | `217902914` |
| `sum("total.out_bytes")` | `505425013` |
| `sum("total.in_events")` | `262912` |
| `sum("total.out_events")` | `342474` |
| `sum("cribl.in_bytes_total")` | **no series matched** |
| `sum("cribl.events_in_total")` | **no series matched** |
| `sum("total_in_bytes")` (underscore) | **no series matched** |
| `sum("total_in_events")` (underscore) | **no series matched** |

**Implication:** the `cribl.in_bytes_total` / `cribl.events_in_total` names previously carried in this document were wrong and returned nothing. Note also that the underscore form `total_in_events` — which is what the `POST /alert/monitors` example in `openapi.json` uses — **also matched no series**. So the spec example's metric name is not portable either.

**Implication now: this finding is why the app names no metric anywhere.** Four spellings of the same measurement were tried and two of them — including the one `openapi.json`'s own example ships — matched nothing. A metric name is therefore not something this app can get right from the browser, so it does not attempt to: the throughput-history read was removed (see §0), and a monitor's PromQL is **copied verbatim from a shipped `isDefault` monitor** rather than composed from a name. The names above are kept as evidence of how far apart the two conventions are, not as constants to compile in.

### 8. One logical feed emits several metric series, and summing them double-counts

Observed on `health.inputs` and `total.in_bytes` split by `input`:

* `subscription:palo_traffic_filtering` **and** `subscription:palo_traffic_filtering:test` — both `bytes = 3169258`
* `subscription:zscaler_web_project` **and** `subscription:zscaler_web_project:zscaler` — both `bytes = 84603299`
* `syslog:in_syslog`, `syslog:in_syslog:udp`, `syslog:in_syslog:tcp`
* `syslog:syslog_in`, `syslog:syslog_in:udp`, `syslog:syslog_in:tcp`

The parent series and its `:suffix` children carry the *same* value, not complementary halves.

**Implication:** match `` `${type}:${id}` `` **exactly**, never by prefix. This now bites in two places rather than one: a monitor's `rules[].includedTags` holds these same `type:id` values, so a prefix match would scope one monitor to a feed and its children, and monitor **attribution** would report one monitor as covering two or three feeds. Both are silent — a row reads watched, and nobody finds out otherwise until an alert fails to fire.

### 9. Pack-scoped feeds have health and traffic but no row in the group config call

The metric store returns pack-qualified dimension values of the form `type:packName.feedId`:

* `splunk_hec:cribl-crowdstrike-rest-io.out_splunk`
* `cribl_search_engine:observeai.observeai-mainSearch`
* `datagen:cribl-palo-alto-networks.palo_traffic` — carrying `33349440` bytes in 1h
* `open_telemetry:observeai.observeai-claudeDesktopOTLP` — carrying `179638` bytes in 1h

None of these appear in `GET /m/default/system/outputs` or `/system/inputs`, which returned 17 destinations for the `default` group, all bare-`id`. The same logical feed can also appear both pack-qualified and bare across different metrics (`cribl_lake:observeai.observeai-claudeDesktopLake` in one query, `cribl_lake:observeai-claudeDesktopLake` in another).

**Implication:** a coverage table built only from the group-level config calls **silently omits every Pack-defined feed**, including ones moving real volume. This is a genuine coverage blind spot, not a cosmetic gap, and an earlier build disclosed it in the UI rather than closing it — a table that reads as complete except for a footnote is still a table an admin will trust. **Pack feeds are now discovered and alerted on.** `GET /m/:gid/packs` lists the installed Packs (filtered to `isDisabled !== true`), and each Pack's feeds are read from `/m/:gid/p/:pack/system/inputs` and `/m/:gid/p/:pack/system/outputs` — the same payload, the same inline `status.health`, a different collection. They get **their own two sections** in the coverage table — not because the options differ (they do not; a Pack row takes whichever mechanism the admin picked for its direction) but because a Pack is a collection an admin reasons about separately and so deserves its own "N unwatched" count, and because a `Pack` column would be blank in every group-level row.

Three consequences the implementation depends on:

* **A Pack feed's metric dimension value is `type:pack.id`**, so `feedMetricKey` takes the Pack as a third argument. The exact-equality rule of finding 8 is unchanged; only the string being compared is.
* **The entries do not carry their Pack**, so `pack` is stamped from the scope the call was made in. Nothing in the response says which Pack a feed came from.
* **A Pack feed's tag is Pack-qualified, and that is now verified rather than assumed.** It had been read both Pack-qualified and bare across different metrics, which blocked the monitor mechanism there: a monitor pins its feed with a metric tag in `rules[0].includedTags`, and a tag matching no series is a monitor created successfully that silently never fires. Re-read on 2026-09-03 against the **throughput** family — the one every shipped query measures — Pack feeds appear only Pack-qualified, no bare-id series exists for any of them, and the bare reading the ambiguity rested on (`cribl_lake:observeai-claudeDesktopLake`) is absent from the metric store entirely. `namespace` is also not a dimension these series carry, so the shipped `{namespace=""}` matcher treats both scopes alike. A Pack feed therefore gets either mechanism. **The narrower rule that replaces the block:** tag form is a property of the metric family, so a query from a different family needs its own check. **Confirmed by a real write as well as by the tag read** — a Source monitor and a Destination monitor were created for feeds inside a Pack on the verification org (2026-09-03) and both landed. That is its own class of evidence: the tag read proves the series exists, and only a write proves the monitor collection accepts a Pack-bearing id and that the object appears where an admin goes looking for it.

### 10. The metric store contains far more feeds than the config calls, including internal ones

`health.inputs` split by `input` returned 47 series, among them `ServiceTcp:search`, `ServiceTcp:secrets`, `ServiceTcp:notifications`, `ServiceTcp:jobs`, `cribl:CriblMetrics`, `cribl:CriblLogs`, `http:http`, `open_telemetry:open_telemetry`, `router:engine_router`, `customer_metrics_storage:metrics_engine_kptest`, and `local_search_storage:engine_kptest`. `health.outputs` returned 32 series against 17 configured destinations.

There is also a **roll-up series carrying no `input` / `output` dimension at all** (`bytes: 217902914`, equal to the ungrouped total).

**Implication:** the config call is the spine of the table and the metric store is joined *onto* it — never the reverse. Iterating metric dimension values to build rows would produce internal plumbing, engine routers, and an unnamed row for the roll-up. Any metric series that does not match a configured feed is discarded silently; any configured feed with no matching series shows "no data," which is distinct from "not covered."

### 11. `status.health` can be absent entirely, not merely `Unknown`

The synthetic `default` destination (`id: "default"`, `type: "default"`, `defaultId: "devnull"`) returned `status: {}` — no `health` key, no `timestamp`, no `metrics`.

**Implication:** the health column must handle `undefined` as a fourth-and-a-half state rather than assuming one of the four documented strings. Treating a missing value as falsy-and-therefore-Green would report a feed as healthy on no evidence at all. Render it as `Unknown` and do not count it toward the healthy tally.

Separately, `status.metrics` was `{}` on **every** destination in this snapshot, while Sources returned genuinely populated per-type metrics. The per-type `status.metrics` object is therefore useful on the Source side and should not be relied on for Destinations.

### 12. Re-verified: `aetos` is still down, and the system-messages path is `GET /system/messages`

The system-messages feed still carries `id: "SERVICE_DOWN_aetos"`, severity `error`: "The service failed to boot due to: No workers registered. Aetos will be unavailable until the problem is fixed." Alongside it, `SERVICE_DOWN_lh_engine_metrics`. Neither message carries a `group` field — see §13a. The `default` Stream group still reports `workerCount: 0` despite having Workers running, which is why that field is no longer consulted — see §13.

The endpoint is **`GET /system/messages`** (`openapi.json` confirms `get`, `post`, and `/system/messages/{id}`), and it is **paginated** — the live response carried `count`, `offset`, `limit`, and `totalCount`. A dead-service message is identifiable by an `id` beginning `SERVICE_DOWN_` with `severity: "error"`.

**Implication now: the app still reads neither `GET /health` nor `GET /system/messages`, and neither path is declared in `policies.yml`** — even though it creates monitors again. The gate those calls existed for is real and is enforced, but through `GET /m/{hostGroup}/system-insights/healthcheck` instead (see §4). That is the better instrument for the decision actually being made: it is scoped to the group the app is about to write to, whereas `SERVICE_DOWN_aetos` is a deployment-wide fact about a service nothing in this app reaches, and fanning it out per group is the exact mistake §13a records. Everything else the app depends on announces its own failure at the point of use: a denied or absent `/conditions`, `/notifications` or monitor collection fails visibly there. The detection recipe is kept here as evidence, not as a step the app performs.

Worker-group enumeration re-verified with `type` values across all products: `stream` (2 — `default`, `defaultHybrid`), `edge` (5), `search` (1), `outpost` (2). Filtering to `type === 'stream'` is what reduces 10 groups to the 2 the app should act on. That part is live behaviour and unaffected.

### 13. `workerCount` does not mean what it looks like, and must not be consulted

Of the two Stream groups, `default` reports `workerCount: 0` while **`defaultHybrid` carries no `workerCount` key at all**. The first reading of this was that absent must not be coerced to `0` — true, but not the real problem.

**Corrected 2026-09-02 against the deployment's actual state:** `default`, the group reporting `workerCount: 0`, *has Workers running*. `defaultHybrid`, the group that omits the field, is the one without them. So the field is not merely sometimes-absent; when present it can be flatly wrong about the thing its name describes. Reading it produced two false statements the admin saw: a group picker entry reading `default — no Workers`, and an engine block quoting "Worker group `default` reports workerCount: 0."

**Implication:** parse it faithfully (`number | null`) and **consult it nowhere.** It must not block a write, must not be cited as evidence in any reason, and must not decorate a group label. This one is unaffected by either mechanism — a group is offered because it is `type === 'stream'` and the API returned it, and nothing about its Worker count is inferred or displayed. It bears directly on host-group discovery: the monitor host is chosen by **probing the collection**, never by picking the group that looks most populated. A field that can be wrong must never be quoted at the admin as a fact — a wrong reason is worse than no reason, because it sends them to fix something that is not broken.

### 13a. A system message with no `group` is about the deployment

The `SERVICE_DOWN_aetos` message carries no `group` field. Scoping it with "no group means it applies to this group" fans one deployment-wide fact out across every group, and the app then announced "The alert monitor engine looks unavailable in `default`" — a claim about a named group that the message never made, once per group.

**Implication at the time:** assess the engine at two scopes. Ungrouped messages give one global verdict, reported once and without a group name; only a message that names a group produces a per-group verdict. The *gate* was separate from the *reporting*: a global failure still had to block monitor creation in every group, since a monitor that cannot fire must never be created.

**Implication now:** the system-messages check is gone, but the scoping rule it taught survives and now governs the healthcheck that replaced it — the engine verdict is read for, and reported about, **the one host group the app would write to**, never fanned out. It is also the reason the degradation rules insist on **one notice per distinct problem, worded after the thing that actually failed**. Evidence has a scope, and a notice must not claim a narrower one than its evidence supports — inventing a per-group claim from a deployment-wide fact is the same error as inventing a per-intent claim from a per-engine failure. Applies directly today: a denied `POST /notifications` is one deployment-wide problem, not one problem per group or per direction.

### 14. Re-verified 2026-09-02, with Insights enabled

Re-probed after Insights was turned on in the org. Nothing in the design changed; four rules gained independent confirmation and one new fact appeared.

* **`health != 0` confirmed on a third feed.** `max("health.inputs")` split by `input` over the `default` group returned 23 series. Every one reads `0` except **`tcpjson:in_tcp_json`, which reads `2`** — and the config call independently reports that same Source as `status.health: "Red"`. `Yellow` and `Unknown` remain unobserved as numbers, which is exactly why the rule is expressed as `!= 0`.
* **Parent-and-child series confirmed again.** `syslog:in_syslog`, `syslog:in_syslog:udp`, and `syslog:in_syslog:tcp` all came back for the single configured Source `in_syslog`. Also present with no config row: `subscription:palo_traffic_filtering:test` and `subscription:zscaler_web_project:zscaler`. Exact-equality join, parent series only.
* **Pack-qualified feeds still carry traffic.** `datagen:cribl-palo-alto-networks.palo_traffic`, `open_telemetry:observeai.observeai-claudeDesktopOTLP`, `open_telemetry:observeai.observeai-claudeCodeCLI` — none has a row in `/system/inputs`. This is the evidence the Pack sections were built on: real traffic, real health, no group-level row.
* **Health is not the enabled test.** `in_syslog_default` and `in_syslog_tls` are both `disabled: true` and both still report `"Green"`.
* **Green-with-error confirmed on three destinations at once.** `dd_test` (datadog), `ngrok_test` (open_telemetry), and `dynatrace_test` (dynatrace_otlp) each report `health: "Green"` alongside `status.error.message` "There is an issue with the underlying destinations. Check cribl.log for more info." The separate error indicator is not a hypothetical case.
* **The synthetic `default` destination still returns `status: {}`** — missing health, to be rendered `Unknown`. `status.metrics` was again `{}` on all 17 destinations.
* **`aetos` is still down**, with `SERVICE_DOWN_lh_engine_metrics` alongside it. Enabling Insights did not restore the monitor engine, so this org still cannot evaluate a monitor even though it can now serve throughput metrics.

### 15. `limit` without `offset` is a hard error on every list endpoint

Sending `?limit=200` alone returned, verbatim and identically from `/conditions`, `/notifications` and `/notification-targets`:

```json
{"status":"error","message":"missing 'offset' parameter, 'offset' is required when 'limit' is provided"}
```

The two pagination parameters are **all-or-nothing**. Note the shape of the failure: a JSON object with **no `items` key**. An app that reads `body.items ?? []` would see "nothing configured" on every single list call and render every covered feed as uncovered — a total, silent coverage inversion from one missing query parameter.

**Implication:** the client must build `offset` and `limit` in the same operation so one can never be sent without the other, and the list envelope must be validated (`assertPaginated`) rather than destructured optimistically. Both are in place and now covered by regression tests. The same `{status, message}` envelope is also the platform's general error shape and is what the client extracts error detail from.

### 16. This deployment does not have the endpoints the spec documents for monitors or the Insights catalogue

A path-existence sweep (GET, bearer-authenticated, against the live org):

| Path | Result |
|---|---|
| `/alert/monitors` | **404** — `Cannot GET`, an Express no-such-route |
| `/alert/history` | **404** |
| `/monitors`, `/alerts/monitors` | 404 |
| `/products/stream/monitors`, `/products/data_insights/monitors` | 404 |
| `/products/lakehouse_engine_metrics/monitors` | **200** — but `{"items":[],"totalCount":0}` |
| `/products` | 404 (no product enumeration) |
| `/system-insights/metrics`, `/system-insights/healthcheck` | **404** |
| `/insights/alerts`, `/insights/monitors`, `/system-insights/alerts` | 404 |
| `/conditions` | **200** |
| `/notifications` | **200** |
| `/notification-targets` | **200** |
| `/system/settings/insights` | **200** |

The org serves no OpenAPI document of its own (`/openapi.json`, `/swagger.json`, `/spec` all 404), so the bundled `openapi.json` cannot be reconciled against it. The 404s persisted after monitors were enabled in the UI, so this is not a service-not-booted artifact of `aetos` being down — although that remains true independently.

**The one monitors endpoint that answers has a dead engine too, so this org can never hold a monitor.** Read from `/system/messages` on 2026-09-02, alongside the long-standing `SERVICE_DOWN_aetos`:

```
SERVICE_DOWN_lh_engine_metrics  severity: error
"The service failed to boot due to: No workers registered.
 Lh_engine_metrics will be unavailable until the problem is fixed."
```

`lh_engine_metrics` is the service behind `/products/lakehouse_engine_metrics/monitors` — the only monitors path that returns 200 here. Both monitor engines on this deployment are therefore down for the same reason (no registered Workers), which explains the empty list: no monitor has ever been created here, and one created now could not fire on either path.

**Consequence for the `rules[]` question, at the time.** The blocker on threshold support was to be resolved by reading one *real* monitor and seeing how `rules[].conditions[].condition` actually encodes a threshold. **This org cannot supply that sample** — not because a path is denied, but because there is nothing to read and no engine to have written it. The sample would have to come from a deployment with a working monitor engine, or from the request the Insights monitor UI issues in a browser. The shape must never be inferred from `openapi.json`; it is a generator collision (`Condition` → `$ref: Function`, the pipeline-function schema) and the spec's own example ships `rules: []`.

**Caveat on method:** Express answers `Cannot GET /path` for a path registered only for `POST`, so this sweep cannot distinguish "absent" from "POST-only". That does not rescue `/alert/monitors` or `/system-insights/metrics`, both of which `openapi.json` documents as `GET`, but it means nothing can be concluded from it about the query endpoints (`POST /system/metrics/query`, `POST /insights/metrics/query`).

**Implication at the time — half the app was aimed at endpoints that may not exist:**

* **Notifications are confirmed reachable end to end** — `/conditions`, `/notifications` and `/notification-targets` all answer.
* **`/alert/monitors` is not reachable here at all.** The only monitors endpoint present is the Lakehouse one, whose schema is `AetosMonitorConf` and whose scope is lakehouse engine metrics, not Stream feed throughput.
* **The Insights metric catalogue path is wrong**, so runtime metric-name discovery has no source. The metric *names* were nevertheless confirmed by querying series directly, so throughput history may still be reachable even though the catalogue is not.

**Implication now — the sweep was right about the paths it tried and wrong about the conclusion, and finding 19 is why.** Every 404 in the table above was probed **at the root**. `/m/{gid}/alert/monitors`, `/m/{gid}/system-insights/metrics` and `/m/{gid}/system-insights/healthcheck` all answer 200. A route missing at the root is not a route that is absent; it is a route at another prefix. This is the same trap as `/system/inputs`, and it cost the monitor mechanism a whole revision.

Three rules come out of this finding, and the first is now the strongest one in the document:

* **Probe at the right prefix, and say which prefix you tried.** A 404 is evidence about a path, not about a capability. Where the app degrades, it names the endpoint *and* the prefix.
* **Never assume a documented path exists.** `openapi.json` documents this org's own missing endpoints. The reverse also holds: the org serves working endpoints the bundled spec does not describe usefully (`rules[]`).
* **The Insights catalogue may be absent even where the metrics are not**, and the two prefixes disagree about what a metric is called. `/system-insights/metrics` 404s at the root; the group-prefixed catalogue answers but returns **underscore-form** names (`total_in_events`) while `POST /insights/metrics/query` takes the **dot-separated** form (`total.in_bytes`). Rather than reconcile two conventions neither of which can be verified from the browser, the app now reads **no metric catalogue and runs no metric query** (§0) and copies a monitor's query verbatim. The only Insights call left is `GET /m/{gid}/system-insights/healthcheck`, at the prefix finding 19 proved.

### 17. The condition catalogue, read in full — and the coverage matrix it implies is inverted

`GET /conditions?offset=0&limit=200&showHidden=true` returned exactly 10 conditions, `totalCount: 10`. Every one carries a real JSON Schema in `schema`, plus a `uischema`. This is no longer an unknown.

| id | name | type | category | `conf` fields beyond `name` |
|---|---|---|---|---|
| `unhealthy-dest` | Unhealthy Destination | metric | destinations | `timeWindow` (min 60s, default 60s), `notifyOnResolution` (default true) |
| `backpressure-dest` | Destination Backpressure Activated | metric | destinations | `timeWindow`, `notifyOnResolution` |
| `persistent-queue-usage` | Persistent Queue Usage | metric | destinations | `usageThreshold` (integer, default 90, min 0, max 99), `timeWindow`, `notifyOnResolution` |
| `low-volume` | **Low Data Volume** | metric | **sources** | **`dataVolume`** — "threshold **below which** a notification is triggered", pattern `^\d+\s*(?:[KMGTPEZYkmgtpezy][Bb])?$` — plus `timeWindow`, `notifyOnResolution` |
| `high-volume` | High Data Volume | metric | sources | `dataVolume` (above which), `timeWindow`, `notifyOnResolution` |
| `no-data` | No Data Received | metric | sources | `timeWindow` (**default `5m`**, also `defaultNew: 5m`), `notifyOnResolution` |
| `persistent-queue-usage-source` | Persistent Queue Usage | metric | sources | `usageThreshold`, `timeWindow`, `notifyOnResolution` |
| `search` | Search Condition | search | search | `savedQueryId`*, `trigger`, `triggerType`, `triggerComparator`, `triggerCount`, `message`* |
| `license-expiration` | License Expiration | message | license | `schema: {}` |
| `monitor-alerts` | Monitor Alerts | monitor-alerts | alerts | `properties: {}` — "Events are received via RPC from MonitorEvaluationService" |

**`conf.name` is confirmed un-overridable.** Every per-feed condition marks `name` as `required`, and its `uischema` pins it to `{"default": "${IO_ID}", "ui:disabled": true}` — Cribl's own UI renders it read-only and bound to the feed. The app's rule that a bulk template must never override `conf.name` matches the platform exactly.

**The catalogue is criss-crossed, and this is the finding that set the app's architecture:**

| | Watches health | Watches volume |
|---|---|---|
| **Sources** | **none** — no source-side health condition exists | **`low-volume`** (plus `no-data`, `high-volume`) |
| **Destinations** | **`unhealthy-dest`** | **none** — no volume condition for destinations |

Each direction has exactly one of the two signals, and they are opposite ones.

**Implication at the time**, when the app offered connectivity and throughput as two separate intents: two of the four cells were impossible, `/alert/monitors` was a 404 so neither had a fallback (§16), and the app had to disable half a four-way grid with a reason naming what was missing.

**Implication now — this asymmetry is why there is one intent.** Both remaining conditions answer the same operational question: *is this feed still moving data?* `no-data` answers it for a Source by watching volume; `unhealthy-dest` answers it for a Destination by watching health. Splitting them into two intents took one working answer per direction and reported it as half-coverage on both sides — every feed permanently uncovered in one column, for a signal its direction was never able to offer. Folding them into one intent turns two half-empty columns into one full one, and nothing is blocked and no warning is needed on this deployment.

That is also why `Signal` (`health` | `volume` | `unclassified`) is a **label, not a routing decision**: it records which of the two a given condition watches so the admin can see it, and both count as coverage. The moment it becomes a requirement — "this feed needs a health alert *and* a volume alert" — the matrix above makes every feed fail it.

The deferred-list items `backpressure-dest` and `persistent-queue-usage*` are also confirmed present and cheap to add, since the form is generated from the schema. They are `unclassified` deliberately: neither answers "is data still moving", so promoting them means giving them their own column, not folding them into this one.

**Classification bug this exposed, and the rule that came out of it:** `classifyCondition` had a `type === 'metric'` fallback to `throughput`. Three live conditions — `backpressure-dest`, `persistent-queue-usage`, `persistent-queue-usage-source` — are `type: "metric"` but watch neither health nor volume, so the fallback filed them as volume coverage. Because Destinations have *no* volume condition, it would have marked a Destination watched for a drop-off nobody was watching for. **Classify by what a condition watches — its id and name — never by its `type`**, and return `unclassified` otherwise. That rule outlived the two-intent design: `unclassified` alerts are attributed and shown, in a row's `other` list, but they never count as coverage. A queue-usage alert on a Destination is real and worth seeing; it is not evidence that data is still arriving.

### 18. The one existing Notification is the Insights bridge, and it is unattributable by construction

`GET /notifications` returned exactly one object:

```json
{"condition":"monitor-alerts","mode":"policy","disabled":true,"targets":[],
 "templateTargetPairs":[],"conf":{},"id":"monitor-source_data_in_rate"}
```

This is how an enabled System Insights rule surfaces: not as a per-feed Notification, but as a single `monitor-alerts` bridge that receives events by RPC from `MonitorEvaluationService`. Note that it reports `disabled: true`.

Every point below still binds, and more tightly than before — `GET /notifications` is now the app's *only* source of existing-alert truth, so anything this list gets wrong lands directly in the one coverage column.

1. **`conf` is `{}`** — no `conf.name`, so there is no feed to attribute it to. It is the textbook case for the "report unattributable alerts as such, never guess" rule, and it must not be counted as coverage for any feed. Note too that its condition, `monitor-alerts`, is `unclassified`: it watches neither health nor volume, so even a `conf.name` would not have made it coverage.
2. **It reports `disabled: true`**, which is the live example behind implementation rule 7 — a disabled alert is not coverage. Counting existence rather than enabled state would have marked a feed watched by an alert that cannot fire.
3. **Two fields absent from `openapi.json`'s example appear on a real object: `mode: "policy"` and `templateTargetPairs: []`.** The read model must tolerate unknown fields — that same tolerance is what lets the configuration view (Workflow 3) render an unrecognised key rather than hide it. They are not undocumented in the schema, though: `Notification.mode` is `enum: ["direct","policy"]` with a three-branch `oneOf`, and that enum is what the routing choice is built on (Architecture Decision 3). **`mode: "direct"` was unobserved when this finding was written and no longer is** — finding 20 catches Cribl's own UI sending it, with `targets: []` and the target inside its pair. The app still emits it only when it has a `templateTargetPairs` entry, because the `direct` branch requires `minItems: 1`, and otherwise writes the bare `targets` shape.
4. **This object is a bridge, and finding 19 identifies what it bridges.** `monitor-source_data_in_rate` is the routing half of the shipped `source_data_in_rate` monitor. That makes the pattern legible: an Insights alert is a monitor plus a `monitor-{monitorId}` Notification. The app therefore sets bridges aside from attribution by that id convention rather than reporting one as unattributed per monitor, and consumes them to answer "does this monitor deliver anywhere?" It also means the conclusion drawn here at the time — that monitors are not reachable as per-feed objects — was wrong: they are reachable under `/m/{gid}/`, and `includedTags` is how one is scoped to a feed.

`GET /notification-targets` returned two targets: `system_email` (`type: smtp`) and `system_notifications` (`type: bulletin_message`), both `health: "Green"`. `system_notifications` is confirmed as a real default routing target.

`GET /notification-templates?engine=handlebars` returned four: `default-email` (`smtp`), `default-sns` (`sns`), `default-slack` (`slack`) and `default-pagerduty` (`pager_duty`). Three things follow, and all three are load-bearing for Architecture Decision 3: the field that pairs a template with a target is **`type`**; `?engine=handlebars` is the only form observed, so it is the only form the app sends; and **no template ships for `bulletin_message`**, which is why a template is optional per target rather than required — `system_notifications`, the deployment's own default target, has none.

### 19. A HAR capture of the org's own Insights UI shows exactly how an Insights alert is built

Captured 2026-09-02 while the native UI created an alert. This is the strongest kind of evidence in the document — not a probe, not the spec, but the platform's own client doing the thing — and it is what made Mechanism B buildable.

**The route exists, under a group prefix.** `GET` and `PATCH /api/v1/m/{gid}/alert/monitors/{id}` answer **200**. Finding 16's 404s were all at the root. `/m/{gid}/system-insights/metrics`, `/m/{gid}/system-insights/metrics/{name}` and `/m/{gid}/system-insights/healthcheck` are group-prefixed too.

**`rules[]` — the schema that `openapi.json` could not give.** From a working monitor:

```json
{
  "query": "rate(total_in_events{namespace=\"\"}[5m])",
  "product": "stream",
  "schedule_interval_seconds": 60,
  "firing_after": 300,
  "ok_after": 60,
  "isDefault": true,
  "params": {},
  "rules": [{
    "name": "…", "showOnChart": true,
    "conditions": [{
      "condition": { "type": "greater_than", "threshold": 100000 },
      "enabled": false,
      "labels": { "severity": "critical" }
    }],
    "includedTags": { "input": ["datagen:ZscalerWeb"] },
    "excludedTags": {}
  }]
}
```

Four things in that object are load-bearing, and each is a rule in Architecture Decision 2:

1. **`includedTags` is how a monitor is scoped to a feed**, and its values are fully-qualified `type:id` — the same strings finding 8's join already builds. This is what makes per-feed monitors viable without hand-authored PromQL.
2. **`query` is PromQL over underscore-form metric names with an empty-string namespace matcher.** Note it is *not* the dot-separated form `POST /insights/metrics/query` accepts (finding 7). The app copies a shipped query verbatim rather than composing one, because it cannot verify from the browser that an expression it wrote matches any series, and an expression matching nothing is a monitor that never fires.
3. **`enabled: false` on the threshold while the monitor itself is enabled.** Every shipped monitor is shaped this way. Coverage therefore requires both, or most feeds would be reported as watched by something that cannot fire.
4. **`isDefault: true` marks the ~38 monitors Cribl ships.** The app never edits one, never lists one against a feed row, and never claims the flag on an object it creates.

**An Insights alert is two objects.** Alongside the monitor, the UI posts:

```json
{"id":"monitor-{monitorId}","condition":"monitor-alerts","mode":"policy",
 "disabled":false,"targets":[],"templateTargetPairs":[],"conf":{}}
```

`mode: "policy"` with empty `targets` is deliberate, not an omission in the capture: monitor alerts route through notification **policies**. `GET /notification-policies` answers 200 with `{"items":[],"count":0}` on this org — the endpoint exists, there are simply no policies. **The app does not create policies**, so a monitor routed by policy on this deployment fires on the Insights page and delivers nowhere. That is a real state and the UI states it out loud: `(not routed)` on the chip, and a warning in the configuration view. It is never smoothed over.

It is also the reason the app does not stop at reproducing the capture. Since the deployment that motivated this app has zero policies, the admin can instead route by **notification target**, on either mechanism — see Architecture Decision 3. Policy remains what the platform's own client posts on create, and is the default *where a policy could carry the alert*; finding 20 is the same UI undoing it where none can.

### 20. A second capture shows the platform's own UI repairing a policy-routed alert — and where an email address lives

Captured 2026-09-02, the same evening, after finding 19's alert had been created and had delivered nothing. This is the specification for what the app now does, because it is the platform's own client fixing the exact failure the app had reproduced faithfully.

**`mode: "direct"` is real, and a templated target is named only in its pair.** The bridge from finding 19 was changed to:

```json
{"id":"monitor-search_errors","condition":"monitor-alerts","mode":"direct","disabled":false,
 "targets":[],"templateTargetPairs":[{"targetId":"system_email","templateId":"default-email"}],
 "conf":{}}
```

→ 200. **Note `targets: []`.** An earlier build of this app named a templated target in `targets` *and* in its pair; that shape has never been seen from Cribl. Reading delivery back off `targets` alone is the mirror of the same mistake: it reports this object — the one Cribl itself repaired — as "nothing is sent". Both directions are now pinned by tests.

**The email address is on the monitor, as `params.to`.** The monitor was patched to `params: {"to": "kprior@cribl.io", "unit": "none"}`. That is the only field that changed between the two captures, and none of the other 40 monitors on the org carries a `to`. It joins up with three other observations: the shipped `default-email` template renders `"to": "{{metadata.to}}"`, `system_email` holds no address of its own, and that target reported `errorCnt: 1` while the recipient was missing. So an smtp route needs an address, the address is a monitor field rather than a routing field, and **a condition Notification — which has no `params` — cannot carry one at all.**

**`POST /notification-policies` also answers 200, with per-feed scoping on this app's own tag:** `{"id":"ZscalerWeb","conditions":[[{"key":"input","operator":"=","value":"datagen:ZscalerWeb"}]],"templateTargetPairs":[…],"order":1,"final":false,"waitToGroup":0,"disabled":false}` — note the array-of-arrays `conditions`, and note that the value is exactly the `type:id` string finding 8's join builds. **Recorded as evidence only.** Creating policies remains out of scope, `policies.yml` grants no POST there, and it must not be added without asking: a policy is deployment-wide routing, not a per-feed alert, and reshaping where a deployment's alerts go is not something an authoring tool should do unasked.

**What this capture cost the app, and what it bought.** It falsified one claim (finding 3's "`direct` is unobserved") and fixed six defects: the double-named target, the read-back that called a repaired alert dead, the missing recipient, a policy default on a policy-less org, a drawer notice that actively discouraged the working route, and existing policy-routed alerts showing in the coverage table as plain coverage. The last one is why "delivers nowhere" is now said in three places rather than one — four alerts were created into that state with a warning already on screen.

**The host group is not the feed's group.** The capture shows the monitors in `default_search` while the feeds live in `default`. Which group a per-feed monitor belongs in is not derivable, so the app probes: `discoverMonitorHost` prefers the group whose collection answers *and* holds the shipped Stream monitors, on the reasoning that such a group demonstrably has a working evaluation engine — which is also the only available answer to finding 4's dead-engine problem.

**The Insights alerts page lists monitors *and* Notifications.** It loads `/products/stream/groups`, `/m/{gid}/alert/monitors`, `/notifications`, `/notification-targets`, `/m/{gid}/alert/silences`. So a Mechanism A Notification is not invisible there; what it lacks is a monitor's chart and threshold, which is what the requirement for Mechanism B was actually about.

## Still To Verify, In Priority Order

Everything above is settled. What remains open is short — not because the questions were dropped with the code that asked them, but because a HAR capture of the org's own Insights UI creating an alert answered the two largest ones with direct evidence rather than argument.

**Closed by Architecture Decision 2, and no longer blocking anything:**

* *How a threshold is expressed in `MonitorConf.rules[]`* — was the largest unknown in the whole design. **Answered by finding 19**, from the platform's own client: `rules[].conditions[].condition = {type, threshold}`, with `enabled` and `labels.severity` beside it. Never inferred from `openapi.json`, which cannot express it.
* *Whether percent-drop-versus-baseline is expressible on `/alert/monitors`* — **not answered, and no longer answerable from the spec.** `openapi.json` was wrong about `rules[]`, so its silence on `type` / `detectionConfig` is not evidence either way. Every monitor captured live carries a flat `{type, threshold}` condition and none does a window-over-window comparison, so the gate is now "capture a real monitor that does this before writing one" — not "the schema forbids it". Deferred for both mechanisms on that basis.
* *Where notification policy IDs come from* — `GET /notification-policies` answers 200 and is empty on this org. The app does not create policies, which is precisely why a policy-routed monitor there is unrouted, said out loud rather than assumed away — and why the admin can route by target instead (Architecture Decision 3). The app never needs a policy *id*: it only counts them, to know whether to warn.
* *Which health conditions the deployment offers* — answered live: `unhealthy-dest` for Destinations, and nothing for Sources. Sources are covered by their volume conditions instead, so the gap costs nothing.

**Still open:**

1. **Whether a monitor created here actually evaluates.** The host group is chosen as the one that answers *and* holds shipped Stream monitors, and healthcheck is read before the capability is offered, but finding 4's `SERVICE_DOWN_aetos` was never re-probed at the group prefix. The honest position: the app can create the object Cribl's own UI creates, in the group Cribl keeps them in, and cannot prove from inside a browser that the evaluator is running. Nothing in the UI claims otherwise.
2. **Whether two feeds in different worker groups can be given distinct monitors.** They cannot today: a monitor's scope is `rules[].includedTags`, a tag carries no worker group, and pinning a `__worker_group` tag this deployment may not support would narrow the monitor to nothing. A shared tag across groups is therefore a **warning** in the preview, and a shared monitor **id** — which the `{monitor}_{feed}` naming makes possible — is a **block**. Closing this needs a live capture of a monitor scoped by group, not a guess at a tag key.

**Closed since:**

* *The exact per-alert URL in the Cribl UI* — **answered.** A monitor's own edit screen is `/insights/alerts/monitors/edit/{id}`, observed in the org's own Insights UI, and both the configuration view and the apply result link straight to it. A condition Notification has no such screen, so its view leads with `/insights/alerts/activity` (which finding 19 proves lists notifications alongside monitors), states that it carries no chart there, and keeps the group's Notifications page as the secondary link. No Insights deep link is ever composed from a route that has not been observed live.

## Workflows

### Workflow 1: Review Alert Coverage (Landing View)

The default view the admin lands on. Answers "what is flowing, is it healthy, and what is watched?"

Steps:
1. Admin opens the app.
2. App lists Stream worker groups (`GET /master/groups`) and defaults to all accessible groups.
3. For each group, app fetches enabled Sources (`GET /m/:gid/system/inputs`) and Destinations (`GET /m/:gid/system/outputs`), filtering out disabled ones. **These calls already carry `status.health`, `status.metrics`, and `status.error`** — no second call is needed to populate the table.
3a. For each group, app also lists installed Packs (`GET /m/:gid/packs`, filtered to `isDisabled !== true`) and reads each Pack's own Sources and Destinations (`GET /m/:gid/p/:pack/system/{inputs,outputs}`), skipping a direction the Pack reports zero of. The payload is identical, health included; the Pack is stamped from the scope, since nothing in the response names it.
4. App renders health as a column straight from that response — `Green` / `Yellow` / `Red` / `Unknown` — plus a **separate error indicator** driven by `status.error`, because a feed can be Green and still carry an error. Health here is a *display* signal: it is what tells the admin a feed is in trouble now, not what the alerts fire on. Expanding a health cell lazily fetches `GET /m/:gid/system/status/inputs|outputs` for the `healthCounts` per-Worker-Process breakdown.
5. App discovers what it can offer before the admin asks: Notification conditions (`GET /conditions?category=sources`, `?category=destinations`) and the monitor collection — probing groups for one whose `GET /m/:gid/alert/monitors` answers, which supplies both the host group and the shipped queries a new monitor can copy.
6. App fetches existing Notifications (`GET /notifications`, plus `GET /m/:gid/p/:pack/notifications` per Pack) and the monitors from the host group, matching each back to the Source or Destination it watches so coverage can be shown per row — the Pack an alert was read from is carried alongside it, because that is what keeps a Pack feed and a group feed of the same name apart. Bridge Notifications (`monitor-{id}`) are set aside from that matching and used to say whether each monitor delivers anywhere.
7. App renders **four sections — Sources, Destinations, Sources in Packs, Destinations in Packs** — each row carrying: name, type, group, the Pack where there is one, current health, error indicator, and **one coverage column** answering "is anything watching this feed for a delivery stop?"
8. Admin sorts and filters to find unwatched rows — the gaps are the point of the screen.

Decision points: narrow to one group; filter to Sources or Destinations only; filter to "nothing watching it"; filter to "currently unhealthy"; filter to "has an error".

An unhealthy feed with nothing watching it is the single most important row in the app and is styled to say so.

### Workflow 2: Bulk-Create Alerts From a Template

The primary value workflow — zero to broad coverage in one pass.

Steps:
1. From the coverage table, admin multi-selects rows, with "select all uncovered" as a shortcut.
2. For each direction present in the selection, admin picks the **mechanism** — an Insights monitor, or a Cribl notification — but only where both are usable. The monitor is preselected, since it is what lands on the Insights alerts page with a chart and an edit screen; where only one mechanism is usable there is no selector and a notice says which and why. **Scope does not enter this choice**: a feed inside a Pack takes whichever mechanism its direction is set to, so there is one selector and one form per direction whatever the mix of scopes. A direction holding Pack feeds says in a line of subtext where the object will land — inside the Pack for a notification, scoped to the Pack-qualified tag for a monitor — because that is worth knowing before it is created, not a second decision to make.
3. Admin fills that mechanism's settings, per direction:
   * *Notification* — the condition, from those the deployment offered for that direction, and that condition's own fields. The form comes from the condition's JSON Schema, including its duration minimums, so the app cannot offer an invalid value.
   * *Monitor* — which shipped monitor's query to copy (shown, never editable), the threshold and its comparison, severity, and the firing/recovery/interval timings.
   The two directions are configured and validated independently, because their conditions declare different fields under some shared names *and* their shipped queries are different objects.
4. Admin chooses how the alerts are delivered — a Cribl notification **policy**, or notification **targets** with a template each — applying to whichever mechanism is in play, since both write a Notification (Architecture Decision 3). Policy is preselected, except on a deployment whose live policy count is **zero**, where the targets route opens instead because policy there provably delivers nothing; no target is ever preselected either way. A target with no template says it will be rendered with that target's own default; leaving the targets route empty says plainly that those alerts will fire and notify nowhere. An **email address** is asked for beside the choice whenever an smtp target is selected, because the shipped email template renders `{{metadata.to}}` and the target holds no address of its own — it is written onto each monitor as `params.to`, and the drawer says out loud that a condition Notification cannot carry one. Either way the admin can choose to create disabled for a dry run.
5. App shows a **mandatory preview step**: one row per selected feed, stating the mechanism, the exact object(s) that will be written — **both** of them for a monitor, named as they will appear on the Insights alerts page — and, for any feed that cannot be covered or is already watched, the reason, so every selected feed is accounted for and no count goes unexplained. Two monitor-specific verdicts appear here: a feed whose monitor id another selected feed would also produce is **blocked**, both of them, naming the clash; a feed whose tag exists in another worker group is created with a **warning** that the monitor will watch both. Nothing is created until the admin confirms. **The preview also repeats any delivery warning** — policy route with no policies, targets route with no targets, an smtp target with no address — because this is the screen the admin has to acknowledge, and a warning only in the Delivery section demonstrably was not enough.
6. Admin confirms. App writes sequentially with progress feedback: `POST /notifications`, or the monitor followed by its bridge, writing a registry entry per created object.
7. App reports per-item success and failure honestly, **including the object(s) as created**, inline, so the admin can see what they just made without leaving the drawer. Partial failure is expected and must not be hidden; failed items stay selected so they can be retried without redoing the configuration. Two partial states have their own wording: an alert created whose registry write failed says both things, and a monitor whose bridge failed reads "created, not routed" and explains that it will appear and fire on the Insights page while nothing is delivered from it.
8. Coverage table refreshes; newly watched rows flip.

Decision points: back out at the preview step; which mechanism per direction; whether delivery goes through a policy or through named targets, which template renders each target, and the address an email-templated alert goes to; create disabled for a dry run.

A denial mid-run blocks the remaining items **of that mechanism only**. The other mechanism may be perfectly permitted, and collapsing them would report a creatable alert as blocked.

### Workflow 3: Inspect a Created Alert

So the admin can answer "what is this alert actually configured to do?" — the question that follows immediately after creating one.

Steps:
1. Admin clicks an alert chip in any row's coverage cell. The chip already says which mechanism it is and qualifies itself when it is not real coverage — `(disabled)`, `(not routed)`, `(unmanaged)`, `(owner unknown)`.
2. App shows the **stored object as Cribl returned it**, headed by whether it is enabled, which mechanism it is, whether this app created it (and on what evidence), and what it watches.
   * *Notification* — each `conf` field labelled from the condition's own schema, plus the condition, the feed watched, the worker group, and the routing (saying so explicitly when there is none).
   * *Monitor* — the feed tags, the feed's group and the host group when they differ, the copied query with a note that the app does not compose PromQL, every threshold with its own enabled state, and the timings. A monitor with no bridge gets a warning saying it fires on the Insights page and delivers nowhere.
3. Fields the schema does not declare are listed too, at the bottom, rather than hidden — an unrecognised key on a live alert is exactly the thing worth seeing. A condition missing from the catalogue is called out, with its settings shown under raw field names.
4. The view links out to the object in Cribl — a monitor to its own edit screen `/insights/alerts/monitors/edit/{id}`, a Notification to `/insights/alerts/activity` (which lists it but shows no chart for it) and to the group's Notifications page — and states that this app creates alerts and never edits them.

This is deliberately a *read* of what exists rather than a re-render of the template the admin filled in — the latter would be wrong for any alert edited in Cribl afterwards, which is the case where an honest answer matters most.

### Workflow 4: Tune an Individual Alert *(deferred)*

For the feeds that need something other than the template default. Would need an item-path grant under `/notifications` (there is none today), render the schema-generated editor, show recent Insights history against the proposed threshold, and confirm before overwriting. Deferred because Workflow 3 answers the pressing question ("what is there?") without the app taking on edit or delete rights over customer configuration.

### Workflow 5: Re-Scan for Coverage Drift *(deferred)*

Sources and Destinations get added over time. Would re-discover feeds, diff against existing alerts, surface "N new Sources and M new Destinations have nothing watching them", and hand the new items to Workflow 2 with the last-used template settings. The template defaults are already persisted for this.

### Workflow 6: Verify Alerts Are Working *(deferred)*

Would fetch recent firing history to show which alerts have fired, how often, and which never have, so the admin can spot noisy and suspiciously silent ones. Deferred: `GET /alert/history` returns a 404 on the verification org.

## Data & Integration Points

### Data Display

* **Enabled Sources and Destinations, with health** — `GET /m/:gid/system/inputs`, `GET /m/:gid/system/outputs`. Returns name, ID, type, `disabled` state, **and `status.health` inline as a string** plus a per-type `status.metrics` object and, on Destinations, `status.error`. Verified: this single call per group per direction supplies everything the coverage table needs on first paint. Items with `disabled === true` are filtered out; they cannot drop data they aren't receiving.
* **Worker groups** — `GET /master/groups`, to scope discovery and label rows. Filter to `type === 'stream'` in app code; the product-type parameter also returns `outpost` groups. `workerCount` is parsed faithfully but **never consulted** (§13).
* **Per-Worker-Process health detail (progressive enhancement)** — `GET /m/:gid/system/status/inputs`, `GET /m/:gid/system/status/outputs`. Adds `healthCounts` per state across Worker Processes and `pq` persistent-queue status. Fetched lazily to expand a health cell, not required for the table to render.
* **Available Notification conditions** — `GET /conditions?category=sources`, `GET /conditions?category=destinations` — the whole read, since the list response carries each condition's `schema` inline. Each condition carries a JSON Schema for its `conf` fields, which the app uses to generate configuration forms and to prune the template's `conf` before sending, and a `description` used as helper text. This is how the app avoids hardcoding condition IDs or field names.
* **Insights engine health, on the monitor host group** — `GET /m/:gid/system-insights/healthcheck`. Group-prefixed, because that is the only prefix at which it answers (finding 19). Read for one decision only: whether a monitor written to that group would be evaluated. `red` disables monitor creation; unreadable leaves it creatable with a notice that nothing can be confirmed. **There is no metric-catalogue read and no metric query** — see "What Insights is still for, and what was removed from it".
* **Installed Packs, and the feeds inside them** — `GET /m/:gid/packs`, filtered to `isDisabled !== true`, then `GET /m/:gid/p/:pack/system/inputs` and `/system/outputs` per Pack. Identical payload to the group-level call, including inline `status.health`; the difference is the collection, which the response does not name, so the Pack is stamped from the scope. A Pack that reports `inputs: 0` or `outputs: 0` is permission to skip that direction's call, not a fact to display. The status endpoints have Pack-scoped forms too (`/m/:gid/p/:pack/system/status/{inputs,outputs}`), fetched lazily per `(group, pack, direction)` exactly like the group-level pair.
  * **A Pack's `default` and `devnull` Destinations are excluded.** Every Pack ships both, so a deployment with a dozen Packs contributes two dozen rows that the app's one question cannot be put to: a `devnull` discards by design, and a `default` forwards to another Destination rather than delivering anywhere itself. They would be most of what each Pack section's "N unwatched" count is counting, which turns the number an admin is meant to act on into noise. Excluded on `type`, not `id` — being a non-delivery sink is what makes a feed unalertable, not what it is called. **Group scope keeps both**: there is one of each rather than one per Pack, so there is no volume of noise there to justify hiding a real row from a coverage audit.
* **Existing alerts** — `GET /notifications` (accepts a **`groupId`** filter) for group-level alerts, plus `GET /m/:gid/p/:pack/notifications` once per discovered Pack. Read per Pack rather than with the `includePacks` flag, because **which collection an alert came from is the only thing that says whether it watches a Pack feed or the group feed of the same name** — a flag that merges them back into one list throws that away. Each is matched back to the feed it targets to compute the coverage column. See "Matching Existing Alerts Back to Feeds" below — this is not a trivial lookup.
* **Notification routing** — three read-only lists, one for each thing the routing choice needs. `GET /notification-targets` populates the target picker (a Notification's `targets` field is an array of notification *target* IDs). `GET /notification-templates?engine=handlebars` populates the per-target template picker, matched on the template's `type`. `GET /notification-policies` is read **for its count only** — the app never needs a policy id, just whether any policy exists, because a policy-routed alert on a deployment with none delivers nothing. The app creates and edits none of the three.
* **Insights monitors** — `GET /m/:gid/alert/monitors`, paged like every other list endpoint, doing three jobs at once: identifying the group that hosts the collection, supplying the shipped `isDefault` Stream queries a new monitor copies, and providing the existing monitors to attribute to feeds through `rules[].includedTags`. `GET /m/:gid/system-insights/healthcheck` is read before the mechanism is offered — a monitor written where nothing evaluates it is an alert that silently never fires. The shipped defaults are skipped when building coverage: they are deployment-wide, and listing 38 of them against every row would bury the real coverage.

**No root-level service-health read.** An earlier revision queried `GET /health` and `GET /system/messages` to detect a dead monitor engine. The monitor mechanism now answers that question the only way available from the browser: it prefers a host group that demonstrably holds Cribl's own working monitors, and reads the group-prefixed healthcheck. It does not report a `SERVICE_DOWN` message the app cannot act on.

**Every list endpoint above is paginated.** `GET /notifications` and `GET /conditions` both take `offset` and `limit` and return `Paginated*` responses. **The app must page to exhaustion on both.** Reading only the first page makes existing alerts invisible, which renders watched feeds as unwatched — the exact silent-miscoverage failure mode that the `type:id` join rule exists to prevent, arrived at by a different route. And `limit` without `offset` is a hard error whose body has no `items` key (§15), so the two parameters are always built together and the envelope is validated.

### Matching Existing Alerts Back to Feeds

The forward direction (feed → metric dimension) is specified above. The reverse direction — the one the coverage column actually depends on, and which must work for alerts the app did *not* create — needs its own algorithm, because the engine does not record the feed in a directly usable form:

* `conf.name` holds the **bare feed ID**, carrying neither `type` nor direction. A Source and a Destination sharing an ID are therefore indistinguishable from `conf.name` alone. **Resolve direction from the condition's `category`** (`sources` versus `destinations`), taken from the discovered condition catalogue, and scope to the group via the Notification's `group` property. Match on `(group, pack, direction, id)`.
* **The Pack is part of the key, and it is exact in both directions.** The alert carries no Pack field either; the Pack it belongs to is the collection it was read from, so each alert is paired with that scope as it is read. A group-level alert must never reach inside a Pack, and a Pack alert must never attribute to the group feed of the same name — both are the same feed ID naming two different feeds. The group-level list is also deduplicated against the group-level ids only, since a Pack alert legitimately shares an id with nothing there.
* **A Notification with no `group` whose name matches feeds in more than one group is genuinely ambiguous.** It is reported as unattributed. Counting it toward both would mark two feeds watched by one alert.
* **A condition not in the discovered catalogue** cannot yield a direction, so its Notification is reported as unattributed rather than assigned to a guess.
* **Ambiguity is surfaced, never resolved by guessing.** Where an alert cannot be attributed to exactly one feed, it is listed as unattributed instead of being silently dropped or double-counted.
* **The stored object is retained** on each attributed alert, which is what lets Workflow 3 show the real configuration without a second read.

### Create / Modify / Delete

**Mechanism A — one write.**

* **Creates Notifications** — `POST /notifications`, one per feed, using a condition discovered for that feed's direction, with `conf.name` set to the feed ID and the remaining `conf` fields taken from the template after pruning against the condition's schema. Required body fields are only `id` and `condition`; `group`, `targets`, `conf`, and `disabled` are optional but all four are set by this app.
* **For a feed inside a Pack the same body goes to `POST /m/:gid/p/:pack/notifications`.** A Pack's feeds are addressable only from inside the Pack, so a group-level Notification naming one in `conf.name` would name a feed the group does not have. The Pack also becomes a segment of the alert id, so a Pack feed and a group feed sharing a name are two alerts rather than one write silently editing the other.

**Mechanism B — two writes, and the second one is what makes the first visible.**

* **Creates an Insights monitor** — `POST /m/{hostGroup}/alert/monitors`, one per feed, with the query copied verbatim from a shipped `isDefault` Stream monitor and `rules[0].includedTags` scoping it to that one feed. `PATCH /m/{hostGroup}/alert/monitors/{id}` is used **only** as the recovery when the POST is rejected because the id already exists (409, or a 400 naming existence). Any other rejection is reported as-is: a blind PATCH after a denied POST would overwrite an object this app did not create.
* **Creates the bridge Notification** — `POST /notifications` of `{"id": "monitor-{monitorId}", "condition": "monitor-alerts", "disabled": false, "conf": {}}` plus whichever route the admin chose. `mode: "policy"` with empty `targets` and pairs is Cribl's own create shape; `mode: "direct"` with `targets: []` and one pair per templated target is Cribl's own repair shape (finding 20). Without it the monitor evaluates and its state is visible on the Insights page, but nothing is delivered — which is why a monitor written whose bridge failed is reported as a **partial** success, chipped `(not routed)`, and never counted as delivered coverage.

* **Available for a feed inside a Pack**, pinned to that feed's Pack-qualified tag, with the Pack carried in the monitor id so two Packs are two objects. This was refused until the tag was verified live; see the Pack-qualified tag finding above for the evidence that lifted it, and note that the collision index has to include Pack feeds — keyed on the Pack-aware id segment — for the id check to stay honest.

**Creates nothing else.** Two Cribl objects, both of them Cribl's own, and no third mechanism. Scope adds a collection, never a mechanism.

#### Group scoping

**Mechanism A** scopes an alert to the group that owns the Source or Destination, using the `Notification` object's **`group`** property, and reads it back with the **`groupId`** query parameter — a plain field, not a filter smuggled into a query.

**Mechanism B has two different groups and they must not be conflated.** The monitor is written to the *host* group whose `/m/{gid}/alert/monitors` collection answers — on the verification org that is `default_search`, while the feeds live in `default`. The feed's own group is carried by the `includedTags` value, not by the path. The coverage table attributes a monitor to the feed's group; the configuration view shows both and says which is which when they differ.

#### Notification routing

**The same choice for both mechanisms, made once per run** — see Architecture Decision 3 for why, and for the four rules that keep the payload inside a `oneOf` branch the schema actually has. Mechanism A writes it onto the Notification; Mechanism B writes it onto the bridge Notification, which is the object that carries a monitor's output anywhere at all.

**Policy** reproduces Cribl's own create exactly: `mode: "policy"`, empty `targets`, empty `templateTargetPairs`. Delivery is then governed by the deployment's notification policies, which this app does not create — so it says that plainly rather than claiming the alert is routed. It is the default only where a policy could carry the alert; a live policy count of zero opens the drawer on targets instead and warns in three places.

**Targets** names notification target IDs from `GET /notification-targets`, optionally with a template per target from `GET /notification-templates?engine=handlebars`. `mode: "direct"` is sent only when there is a pair to satisfy the schema's `minItems: 1`, and a templated target is named **only** inside its pair, so `targets` holds the untemplated remainder and is `[]` when every target is templated — exactly the object in finding 20. Targets with no template at all are written as a bare `targets: [...]` with no `mode`, which is the shape every alert this app created before the choice existed.

**The email recipient** is part of this choice but is not a Notification field. Where an smtp target is selected, the address is written onto each **monitor** as `params.to`, over the copied `params`, because that is where Cribl's own UI put it and where the shipped `default-email` template reads it from. Mechanism A cannot carry it — a condition Notification has no `params` — and the drawer says so rather than silently dropping it.

#### Creating alerts disabled

A Notification is switched off with `disabled: true`. A monitor is switched off with `enabled: false` — **note the inverted sense**, and note that the two halves of Mechanism B use opposite fields: `createDisabled` sets `monitor.enabled = false` *and* `bridge.disabled = true`.

**A disabled alert is not coverage** — counting one would report a watched feed that nothing is watching. For a monitor the test has two parts, because the shipped monitors are `enabled: true` with every threshold `enabled: false`: a monitor counts only when the object is enabled **and** at least one of its threshold conditions is enabled.

* **Does not delete alerts**, including its own — no DELETE is granted on either object, in `policies.yml` or in code, and no item path under `/notifications` is declared at all, so a Notification cannot be edited. The one write verb beyond creation is the `PATCH` recovery on a monitor id that already exists, described above; it is not a general edit path and there is no UI that reaches it. Should tuning (Workflow 4) ever ship, an overwrite must be confirmed by naming the object, and never triggered on render or a timer.
* **Writes app-local state** to the app-scoped KV store (see State & Secrets).
* **Never modifies** Sources, Destinations, pipelines, routes, notification targets, notification policies, Insights settings, or a Pack. The app reads platform configuration and writes only alerting configuration. Packs are read to find the feeds inside them, and the only Pack-scoped write declared anywhere is a Notification into `/m/:gid/p/:pack/notifications`. Insights settings are not written — and no longer read either, since the column that needed them is gone.

### External Integrations

**None.** Every call goes through the Cribl API. `config/proxies.yml` stays empty, there is nothing external for an admin to approve at install time, and the app holds no third-party credentials.

Alert delivery is the platform's job: the app attaches an existing notification target to each alert it creates, and Cribl handles Slack, email, or PagerDuty delivery. The app never sends a notification itself.

## Permissions & Access

### Different Users See Different Data?

**No app-level filtering.** The app renders whatever the Cribl API returns for the signed-in user. Cribl's own RBAC and worker-group ACLs are the single source of truth for who can see which groups, sources, and destinations — the app deliberately adds no parallel authorization logic, because a second access model would drift from the platform's and give a false impression of what a user can see.

Practical effect: an admin with access to two of five worker groups sees two groups' worth of feeds, presented as normal rather than as an error.

### Permission-Denied Behavior

**Degrade gracefully and keep whatever value is still available.** Each capability fails independently rather than taking down the page. There are four: `alerting` (Mechanism A), `monitors` (Mechanism B), `routingTargets`, and `registry`. **Only `alerting` and `monitors` can block a write, and each blocks only its own mechanism** — that independence is the point of having two, so losing one leaves the other creatable. `routingTargets` and `registry` can never cost the admin an alert.

* **Notification write denied** — Mechanism A is not creatable. Those items are blocked with that reason; monitor items are unaffected, and the coverage table still renders in full as a read-only coverage and health audit.
* **`GET /conditions` denied** — `alerting` is unavailable, because condition IDs are never guessed and there is no fallback route. Say so plainly rather than implying a workaround exists. It does **not** gate a monitor, not even the bridge: the bridge uses the fixed `monitor-alerts` condition and consults no catalogue.
* **`GET /conditions` readable but offering nothing for one direction** — not a capability failure; half the app works. Emit one up-front notice naming the direction that cannot be alerted on, so an admin who selects it does not find every row blocked without explanation.
* **No group's `/m/{gid}/alert/monitors` answers** — `monitors` is unavailable, naming the groups probed and what each returned, so a 403 is never reported as a missing route. Mechanism A is unaffected.
* **The host group holds no shipped throughput monitor to copy** — `monitors` is unavailable, saying so: the app does not compose PromQL, and hand-authored PromQL matching no series would produce a monitor that silently never fires.
* **The Insights engine on the host group reports `red`** — monitor creation is disabled rather than reported as working. If the healthcheck cannot be read at all, monitors stay creatable with a notice that the app cannot confirm anything will evaluate them.
* **The bridge write fails after the monitor succeeded** — a *partial* success, not a failure and not a success. The item says the monitor was created and is not routed, the chip carries `(not routed)`, and the configuration view warns that it fires on the Insights page and delivers nowhere.
* **Status endpoints denied** — only the `healthCounts` breakdown on row expand reads "unavailable." The base health column is unaffected, because it arrives inline with the discovery call.
* **Notification targets denied** — **only the targets route is lost, and it is lost for both mechanisms.** Alerts stay creatable by policy, and the app states once that routing by target is unavailable here and must be attached in Cribl separately. The drawer separately warns when the admin picks the targets route and then leaves it empty *by choice*: such an alert fires but notifies nowhere.
* **Notification templates unreadable** — targets are still offered, each rendered with its own default, said inline beside the template pickers. A template read failure never costs an alert.
* **The notification policy count unreadable** — the drawer says the policy route could not be checked, and does not claim there are none: a policy the app cannot see may still exist, and refusing to write over a read failure would be worse than writing something the admin was warned about. A count of **zero** is a fact rather than an unknown and gets the harder treatment: it flips the default to the targets route, it is repeated on the mandatory preview, and it is stated on the configuration view of any existing alert that routes by policy. Neither state blocks a write — a policy the admin is about to create does not exist yet, and refusing to create an alert over a routing choice would be worse than creating one the admin was warned about three times.
* **An smtp target selected with no email address** — warned, not blocked, in the drawer and again on the preview. The address is written to the monitor's `params.to`; a condition Notification cannot carry one at all, which is said rather than worked around.
* **Registry unreadable or unwritable** — coverage still works off the live read; alerts show as "unmanaged" rather than "created by this app". An alert created whose registry write failed reports both facts.
* **A single worker group denied** — that group is skipped with a note; other groups render normally. One inaccessible group never fails the whole discovery pass.
* **A monitor's feed tag matches no feed** — suspect the `type:id` join (Verified findings 8–10) before concluding the monitor is misconfigured. Report it as unattributed, naming the tag, rather than dropping it: an alert nobody can see is worse than one attributed loosely.
* **`GET /m/:gid/packs` denied, or one Pack's feed read denied** — the Pack sections are empty or short by that Pack, said once, and the two group-level sections are unaffected. **Packs are deliberately not a fifth capability**: a Pack read failure costs the rows it could not fetch and nothing else, and folding it into `alerting` would report a mechanism as broken because a collection was unreadable.
* **A Pack's alert collection unreadable** — that Pack's feeds still render, but their coverage column is built from a list the app could not read, so **the notice says out loud that feeds in that Pack may show as unwatched when they are not**, naming the Pack and what the call returned. "Nothing is watching this" and "the app could not look" are different claims, and the second one must not be presented as the first. Registry entries pointing into that Pack are **not judged**: an unreadable collection is not evidence the alert is gone, so they are left alone rather than pruned. A Pack that is genuinely gone from the Pack list **is** judged, because that is a real absence.

**One notice per distinct problem, not one per affected capability.** An earlier build produced four alerts saying the same sentence about the alert-monitor engine: two capability warnings, a per-group engine warning, and a line in the notice list. A stack of alerts nobody reads is worse than one that lands. So: collapse capabilities blocked with an identical reason; do not report the *downstream* consequences of a blocked route at all; and derive severity from whether alerting is *entirely* impossible rather than defaulting to `warning`. With two mechanisms that means **only both being unavailable earns `danger`** — one mechanism down is a `warning`, because the admin can still create an alert. What must never be collapsed away is a capability the admin would otherwise assume is working.

In every case the app names the missing permission and what the user can still do, rather than showing a generic error or an empty screen.

## State & Secrets

All persistence uses the **app-scoped KV store** (`CRIBL_API_URL + '/kvstore/...'`). No `localStorage`, `sessionStorage`, `IndexedDB`, or cookies — the app runs in a sandboxed iframe where browser storage is unreliable and never shared across users or devices. Values are written as serialized strings per the Cribl Apps KV guidance, and reads accept both a string and a raw object, because values written by an earlier build are still out there and no migration is performed.

### Saved State

**1. Managed-alert registry** — `cc-simplified-alerting/managed/{notification|monitor}/{id}`

The path segment is the mechanism, and it has to be. The two ids come from different schemes now (`csa-{group}-{feed}` versus `{template}_{feed}`), but that is a fact about today's naming, not a guarantee: the two objects live in different Cribl collections, so nothing stops a monitor and a Notification from sharing an id, and a single path would let one record overwrite the other for the same feed and lose which mechanism and host group were used. Keying on the mechanism also makes reconciliation per mechanism possible, which is what the section below turns out to require. Both prefixes are listed on load; `notification` is unchanged, so records written before monitors existed still read back with no migration.

A record per alert the app created, holding its ID, the worker group, the feed ID, its direction, the signal it watches, and the template settings used. A Notification record also carries **the Pack it was written into**, since that is the collection a later load has to look in to find the object again. For a monitor the settings also record `mechanism: 'monitor'`, the host group it was written to, the template it copied its query from, and its bridge's ID. A monitor record needs no Pack: a monitor for a Pack feed is written to the host group's own collection and identified by its Pack-bearing ID, so it reconciles against that one list either way.

**The bridge's ID, and deliberately not whether the bridge write succeeded.** Whether a monitor is routed is read live, not remembered: the bridge is either in `GET /notifications` on the next load or it is not, and `routed` is derived from that. A cached "routed" flag could only ever disagree with the platform, and it would be stale in exactly the direction that matters — an admin who attaches routing by hand afterwards would still be told the alert delivers nowhere. The ID is stored because it is the key the live read is looked up by. A partially created alert therefore survives a reload as a partial by construction rather than by bookkeeping.

It is what lets the coverage column distinguish "created by this app" from an alert the admin built by hand, without inferring ownership from naming conventions that a human could rename or that could collide.

**There is one fallback, and it is not a naming convention.** A registry write can fail after the alert itself lands, and without a fallback the configuration view would tell an admin that an alert they had just watched the app create was not created by the app. So authorship is also claimed from a string the app itself wrote into the object: the `csa-` id namespace for a Notification, and for a monitor the fixed marker sentence at the head of `description`, since its id no longer carries a namespace. Both are **labelling only** — an alert recognised this way is labelled differently from one the registry confirms, and neither ever feeds coverage counting.

Reconciliation requirement: the registry is a cache, not the truth. On load the app cross-checks each entry against **the read for its own mechanism** — Notifications against `GET /notifications`, monitors against the host group's monitor collection — and drops entries whose object no longer exists, so stale entries never make an unwatched feed look watched. Reconciling monitor entries against Notifications alone would delete every one of them on load and report the app's own monitors as unmanaged. And when **no host group answered**, monitor entries are not judged at all: they would look stale for exactly the same reason they look invisible, and the app would delete its own record of a monitor that is still there. The same rule covers Packs, and for the same reason: an entry written into a Pack whose alert collection could not be read is left alone, while an entry written into a Pack that is genuinely gone from the Pack list is judged — an unreadable collection is not evidence of absence, but an absent Pack is. An alert that exists but isn't in the registry still counts toward coverage — it is just shown as unmanaged.

**2. Last-used template settings** — `cc-simplified-alerting/template-defaults`

The chosen mechanism, condition and `conf`, and monitor settings — all **per direction** — plus the delivery route from the most recent bulk apply: the route itself, the selected targets, the template chosen for each, and the email recipient (personal data rather than a secret, stored so an admin does not retype an address on every run). Per direction because the two directions land on different conditions declaring different fields, and can even use different mechanisms, so a single shared `conf` would carry a key the other side does not declare. **Routing is the exception and is stored once**, because it is not a property of what is being watched — an admin who wants alerts in Slack wants both directions there.

Because a stored template is an input to a write that cannot be re-validated against a platform schema, it is coerced **field by field** on read: a threshold, severity, or timing from an older build that no longer parses falls back to that one field's default rather than rejecting the whole record or, worse, becoming a threshold nobody chose. Routing is coerced against the live reads for the same reason — a deleted target, or a template that no longer matches its target's `type`, falls out rather than being sent — with one deliberate migration: a stored target list with no stored route reads back as the *targets* route, because for a build that predates the choice that list was the decision. Makes the recurring "new feeds appeared, cover them the same way" pass near-one-click.

### General Settings

Template defaults above are the app's shared settings, stored at app scope so the whole admin team applies consistent windows and thresholds rather than each admin inventing their own.

### User-Specific Settings

**None.** View preferences (selected worker group, filters, sort order) are deliberately *not* persisted — they live in component state and the URL only. Every admin sees the same deployment-wide coverage picture on open, which is the right default for a shared operational tool: a remembered filter is exactly how someone misses an unwatched source.

### Secure Secrets

**None.** The app makes no external calls and holds no third-party credentials. Authentication to the Cribl API is injected by the platform's fetch proxy — the app never sees a token. Alert delivery credentials belong to the notification targets the app references by ID.

## Scope

### Must-Have (MVP)

Workflows 1, 2, and 3 — see the gap, cover it, and see what you covered it with.

* Discover Stream worker groups (filtering to `type === 'stream'` in app code); discover Sources and Destinations per group with health inline, filtering out `disabled === true`, and treating a **missing** `status.health` as `Unknown` rather than healthy.
* Correctly join config objects to metric dimension values: construct `` `${type}:${id}` `` and match **exactly** — no prefix matching (it double-counts `:suffix` child series), no parsing the dimension value back apart, discard the undimensioned roll-up series, and discard metric series with no configured feed.
* **Discover Packs per group** (`GET /m/:gid/packs`, filtered to `isDisabled !== true`) and read each Pack's Sources and Destinations from its own collection, stamping the Pack from the scope the call was made in and building the metric key as `type:pack.id`. Give them **their own two sections**, and alert on them with **either mechanism, exactly like a group-level feed** — a Notification created **inside the Pack** (`POST /m/:gid/p/:pack/notifications`), or a monitor written to the discovered host group and scoped to the feed's Pack-qualified tag, with the Pack carried in the monitor id.
* **Page every list endpoint to exhaustion** (`/notifications`, `/conditions`, each Pack's `/notifications`), always sending `offset` alongside `limit` and validating the envelope.
* **Match existing alerts back to feeds** on `(group, pack, condition category, conf.name)`, with the Pack exact in both directions. Report unattributable alerts as such rather than guessing, including the genuinely ambiguous groupless-name-in-two-groups case.
* Set group scope with the Notification's `group` field, and read back with `groupId`.
* Routing from `GET /notification-targets` — one ID space, one picker.
* Discover available Notification conditions and their JSON Schemas at runtime; **generate the settings form per direction from those schemas** and prune the outgoing `conf` against them. Never fabricate a condition ID; where a direction has none, say so and create nothing.
* Classify conditions by what they watch, never by `type`. Count `health` and `volume` as coverage; show `unclassified` alerts on the row without counting them.
* **Mechanism B, discovered end to end**: probe for the group whose `/m/{gid}/alert/monitors` collection answers, offer only the shipped `isDefault` Stream throughput monitors as templates, copy the chosen query **verbatim**, scope it with `rules[0].includedTags`, write exactly one *enabled* threshold condition, and create the `monitor-{id}` bridge Notification so it routes. Never compose PromQL, never write a monitor where nothing will evaluate it, and never report an unbridged monitor as delivered coverage.
* **Choose the mechanism per direction**, defaulting to Mechanism B wherever it is usable and falling back to Mechanism A, with each mechanism blocked only by its own capability.
* **Read monitors back into the same coverage column**, joining on `includedTags`, skipping Cribl's deployment-wide shipped defaults, and counting one only when the object is enabled **and** at least one threshold condition is.
* Coverage table split into **four sections — Sources, Destinations, Sources in Packs, Destinations in Packs** — each with its own "N unwatched" count, and each row carrying name, type, group, the Pack where there is one, current health, a **separate error indicator** so a Green-with-error feed is visibly not fine, and **one coverage column**. Scope earns a heading for a different reason than direction: not because the options differ, but because a Pack is a collection an admin reasons about separately and so needs its own "N unwatched" count, and because the `Pack` column belongs only to those two sections.
* Filters for group, direction, "nothing watching it," "currently unhealthy," and "has an error."
* Multi-select rows plus a "select all uncovered" shortcut.
* Bulk-apply drawer: pick the mechanism and then its settings per direction — a condition and its schema-driven `conf` for a Notification, a template and threshold for a monitor — then choose delivery: a notification policy, or targets with a template each and an email address where an smtp target is chosen, with a warning wherever the chosen route would notify nowhere and the default opening on targets where the deployment has no policy; optionally create disabled.
* Mandatory preview listing every selected feed with **both objects** where Mechanism B is chosen, exactly as they will be sent, a repeat of any delivery warning, and a stated reason for anything blocked or skipped — nothing created before explicit confirmation.
* Sequential creation with progress, honest per-item reporting including the object as created, **partial success as its own outcome** when a monitor is created and its bridge is not, per-mechanism denial that does not block the other mechanism, and retry of failures.
* **Click-through configuration view** for any attributed alert, read from the stored object, labelled from the condition's schema for a Notification and showing tags, host group, copied query, per-threshold enabled state and timings for a monitor — with delivery read from `targets` **and** the pairs, and a warning where a stored policy route meets a live policy count of zero.
* Managed-alert registry — keyed per mechanism — and per-direction template defaults in KV, with reconciliation of each mechanism against its own read.
* Graceful degradation for each denied permission and for Insights being disabled or unhealthy.

### Nice-to-Have (Defer)

* **Workflow 4 — per-alert tuning editor**, with the threshold-versus-history chart. Highest-value deferred item, and the natural extension of the configuration view, which today reads but does not write.
* **Workflow 5 — drift banner**, proactively surfacing newly added feeds with nothing watching them. The persisted template defaults already exist for it.
* **Workflow 6 — firing-history view**, to spot noisy and suspiciously silent alerts. Blocked on `GET /alert/history`, which 404s at the root on the verification org — worth re-probing under `/m/{gid}/`, since that is exactly the prefix mistake that hid the monitor route. Monitors partly answer this need already by landing on the Insights Activity page, which the app links to rather than reproducing.
* **`backpressure-dest` and `persistent-queue-usage*` alerting.** Both are confirmed present in the live catalogue and take the same Notification shape, so this is cheap: they are classified `unclassified` today, shown on the row and deliberately not counted, and promoting them is a matter of deciding what they should count toward.
* **Alerting on `status.error` presence**, to close the Green-with-error blind spot. Needs a mechanism that can evaluate it server-side, which is why it is not in MVP.
* Alerting on the per-type source metrics already returned by the discovery call — `broken` / `activeBreakers` for TCP and Splunk feeds, `numErrors` / `numDropped` for OTel — which are more specific signals than aggregate health.
* Distinguishing `Yellow` (degraded) from `Red` (critical) as separate severities.
* Suggested thresholds computed from each feed's own observed baseline.
* Bulk disable and bulk delete of app-managed alerts.
* Edge fleet coverage in addition to Stream worker groups.
* Export the generated alert set as config for review or version control.
* **Percent-drop-versus-baseline, anomaly, forecast, outlier, and change detection.** These need a monitor, which now exists — the remaining unknown is the `condition` shapes beyond `less_than` / `greater_than`, which must be read off a real monitor from the native UI before being written, exactly as the threshold shape was. **Do not infer one from `openapi.json`**; that is what produced the generator collision in the first place.
* **Alerting on a metric the shipped monitors do not measure.** Any such alert requires composing PromQL, which this app deliberately does not do. The step to take first is proving a hand-written query against `POST /insights/metrics/query`, not writing one into a monitor.

### Out of Scope

* **Evaluating alerts in the app.** Cribl's Notification engine does this. Non-negotiable.
* **An alerting engine of the app's own, or a third mechanism beyond the two Cribl objects.** Two mechanisms, both of them Cribl's, for the reasons in Architecture Decision 2.
* **Composing PromQL.** A query is copied from a monitor Cribl ships or the app creates nothing. A hand-authored query that matched no series would produce a monitor that silently never fires — the worst failure this app can have.
* **Creating notification policies.** A policy is shared routing configuration for the whole deployment, and an authoring tool must not quietly reshape where a deployment's alerts go. Where the admin routes by policy, delivery is governed by the deployment's own policies, which the app states and does not configure; where there is no policy to route through, the answer is the targets route, not a policy this app invents. **This is a choice, not a limitation:** finding 20 records `POST /notification-policies` answering 200 with per-feed scoping on exactly this app's own `type:id` tag. It stays out of scope, `policies.yml` grants no POST there, and it is not to be added without asking.
* **Defining a custom health model.** The app consumes the platform's `health` verdict as-is and displays it. It does not compute health from error counters, connection counts, or throughput, because a second health definition would disagree with the Cribl UI and erode trust in both.
* **Health alerting as a separate intent.** Health is a display column. The catalogue offers no Source health condition, and the delivery-stop alert is what the admin actually needs.
* **Sending notifications.** The app attaches existing targets; the platform delivers.
* **Creating or editing notification targets, templates and policies.** All three are read-only inputs to the routing choice; the admin manages the objects themselves in the Cribl UI.
* **Authoring new Notification conditions.** The app uses what `GET /conditions` reports.
* **Editing or deleting alerts, including its own.** The app creates; Cribl edits. Enforced by declaring no item path under `/notifications` and no DELETE anywhere. The single exception is narrow and stated: `PATCH` on a monitor id that already exists, as the recovery when creation is rejected for that reason.
* **Modifying Sources, Destinations, pipelines, or routes.** The app reads platform configuration and writes only alerting configuration.
* **Changing Insights settings.** If Insights is off, the app explains and links out rather than enabling it.
* **Replacing Cribl's alerting UI.** No general-purpose alert browser, no silence management, no triage or acknowledgement.
* **Root-cause analysis.** The app answers "is this feed still delivering?", not "why not."
* **Edge fleets, Search, Lake, and Lakehouse coverage** for MVP.
* **Installing, editing, or removing a Pack.** Packs are read to find the feeds inside them; the Pack itself is never written, and no such path is declared.
* **Non-admin personas.** Ops and on-call engineers consume alerts through notification targets and never open this app.

## UI Preferences

### Overall Structure

**Table-first with a bulk-apply drawer.** One dense coverage table is the home screen and the whole product surface for MVP. Selecting rows opens a side drawer to configure settings, preview exactly what will be created, and confirm — no page navigation between selecting work and doing it.

Rationale: the admin's job is a sweep across dozens of feeds. A wizard optimises for one careful item at a time and would make the actual task tedious; a dashboard optimises for looking rather than doing. The table keeps the gap list and the fix in the same view, and the drawer keeps context visible while configuring.

Layout:

* Header: worker-group selector, direction filter, "uncovered only" and "unhealthy only" filters, free-text search, and a coverage summary (for example "34 of 51 feeds watched, 2 in trouble with nothing watching for it").
* Four sections, each headed with its own "N unwatched" count: **Sources, Destinations, Sources in Packs, Destinations in Packs**. Scope is a heading and not just a column because a Pack is a collection an admin reasons about separately — it earns its own unwatched count — and because a `Pack` column would be blank in every group-level row. It is **not** a heading because the options differ: a Pack row takes whichever mechanism its direction is set to.
* Table: one row per enabled Source or Destination, with a leading selection checkbox, a Pack cell on the Pack sections (the Pack's display name, falling back to its id), a health cell that expands to show the per-worker-process `healthCounts`, an always-visible error indicator, and **one coverage column** whose alert chips are clickable. **One column for both mechanisms**, because there is one question — is anything watching this feed for a delivery stop? The chip says which mechanism answers it and qualifies itself when it is not real coverage: `(disabled)`, `(not routed)`, `(unmanaged)`, `(owner unknown)`.
* Sticky action bar when rows are selected: "N selected — Create alerts."
* Drawer: mechanism per direction → that mechanism's settings (condition schema, or template and threshold) → delivery route (policy, or targets with a template each) → preview list → confirm. Preview is a step the admin cannot skip, and it shows **both objects** for a monitor.
* Results: inline per-item outcomes after the apply, each with the object as created, partial success reported as partial, and failures retryable.
* Configuration view: opened from any alert chip, showing the stored object as Cribl returned it, with a body specific to the mechanism, and a link out to the native Cribl UI — a monitor's own edit screen for a monitor, the Insights alerts page and the group's Notifications page for a Notification — so the app is never a black box.

Routing uses React Router with `basename={window.CRIBL_BASE_PATH}`. Filter and group selections live in the URL so a view can be shared or reloaded.

### Look / Feel

**Capra design system** (`@capra/core`, `@capra/icons`, `@capra/theme`), already present in the scaffold, per the guidance in `AGENTS.md` and https://capra.cribl.io/llms.txt. The app should look like a native part of the Cribl UI, not a bolted-on tool.

* Use Capra design tokens in CSS via the custom `token()` function — never a raw CSS variable. **Verify a token exists before using it:** the postcss plugin passes an unknown token through as invalid CSS and the browser silently drops the declaration, so a typo costs a layout rule with no error anywhere. `spacing.xxs` and `radius.sm` do not exist; valid spacing is `none|xs|sm|md|lg|xl|2xl` and valid radius is `md|lg|xl|full`.
* Do not apply CSS classes to Capra components; handle spacing with wrapper elements outside them.
* Do not write selectors that depend on Capra internals, class names, or DOM structure.
* Dense, scannable table styling — this is an operational audit view, not a marketing page.
* Health uses Capra's semantic status tokens so `Green` / `Yellow` / `Red` / `Unknown` read correctly in both light and dark themes without custom color handling, and match how health is coloured elsewhere in Cribl.
* Coverage state carries clear visual weight: an unhealthy feed with nothing watching it should be the first thing the eye lands on, and unwatched feeds should stand out from watched ones.
* An alert chip is a button, so it needs a focus ring and a pointer cursor, but the Capra `Tag` inside keeps its own appearance — the affordance comes from the interaction states, not from a second border.
