---
summary: "Optional automatic work journal built from periodic screen snapshots"
read_when:
  - You want a Dayflow-style timeline of your day in the Control UI
  - You are enabling or configuring the bundled Logbook plugin
  - You want standup summaries or day recall grounded in screen activity
title: "Logbook plugin"
---

The Logbook plugin turns screen activity into an automatic work journal. It
captures periodic screen snapshots from a paired node, summarizes them into
timestamped observations, and builds timeline cards in the
[Control UI](/web/control-ui). It can also generate daily standup notes and
answer questions about a tracked day.

OpenClaw-owned state stays on the Gateway under `<state-dir>/logbook/`, but
model processing is not necessarily local. Sampled screenshots go to the
configured vision route; observations and timeline text go to `textModel`, or
the default agent model when it is unset. Use local model routes for both stages if screen content and
derived activity text must stay on the machine.

Logbook is bundled and disabled by default. Enabling the plugin opts the
Gateway into screen capture because `captureEnabled` defaults to `true`.

## Before you begin

You need:

- A connected node that exposes `screen.snapshot` or `logbook.snapshot`. The
  macOS app node needs Screen Recording permission. A headless macOS node host
  (`openclaw node host run`) gets the plugin-provided `logbook.snapshot`
  command backed by the system `screencapture` tool.
- A provider supporting structured image extraction: Codex or a vision model
  served through the native Ollama API. For Codex, sign in with
  `openclaw models auth login --provider openai`; see
  [Codex harness](/plugins/codex-harness) for other auth paths.
- A working `textModel` or default agent model. Logbook uses it to synthesize cards, standup
  notes, and day Q&A after the vision pass.

## Quickstart

Enable the Codex and Logbook plugins:

```bash
openclaw plugins enable codex
openclaw plugins enable logbook
```

Configure an explicit vision model for deterministic startup:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
      logbook: {
        enabled: true,
        config: {
          visionModel: "codex/gpt-5.6-sol",
        },
      },
    },
  },
}
```

If you use `plugins.allow`, include both `codex` and `logbook`. Restart the
Gateway after changing plugin configuration, then inspect the registrations
and open the dashboard:

```bash
openclaw gateway restart
openclaw plugins inspect logbook --runtime --json
openclaw nodes status --connected
openclaw nodes describe --node <idOrNameOrIp>
openclaw dashboard
```

The node description must include `screen.snapshot` or `logbook.snapshot`.
Headless nodes advertise `logbook.snapshot` only after the plugin is active.
See [Node troubleshooting](/nodes/troubleshooting) if the command is missing.

The Logbook tab appears only for an enabled plugin and an `operator.write`
Control UI session. The status row should show **Capturing** without an error.
A timeline card appears when the analysis window closes, or you can select
**Analyze now** after activity has been captured.

## How it works

1. **Capture**: every `captureIntervalSeconds` (default 30s), Logbook invokes
   the selected node's capture command and stores a scaled JPEG frame.
   Consecutive identical frames are marked idle and excluded from analysis.
2. **Observe**: once an analysis window (default 15 minutes) elapses, the
   plugin samples up to 16 active frames and analyzes them in chunks of four.
   Each chunk produces one bounded work-resumption record with host-owned
   sample times, committed before the next chunk starts. A capture gap longer than two minutes or
   local midnight also closes the current window.
3. **Synthesize**: observations plus the last 45 minutes of existing cards are
   revised into timeline cards (10-60 minutes each) with a title, summary,
   category, main app, and any brief distractions.
4. **Recover**: a failed stage retries after one minute, then five minutes,
   with at most three attempts per stage. Completed chunks survive restart;
   card failures reuse saved observations without another vision pass.
5. **Prune**: completed observation frames expire after `retentionDays`
   (default 14). Unfinished frames have a bounded grace period of at least seven
   days, or `retentionDays` when longer. Expired active captures leave unavailable
   interval metadata. Cards, observations, and cached standups are kept until
   explicitly deleted.

Day boundaries and timeline clocks use the Gateway's local timezone, not the
browser's timezone. Frames and the SQLite timeline database live under
`<state-dir>/logbook/`.

## Model and data flow

Logbook uses two separate model routes:

| Stage            | Data sent                                                     | Model route                                                       |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Observe          | Up to four sampled JPEG frames per request plus capture times | `visionModel`, or a compatible borrowed `tools.media` Codex entry |
| Synthesize cards | Timestamped observations and recent timeline cards            | `textModel`, otherwise the default agent model                    |
| Generate standup | Cards for the selected day and previous day                   | `textModel`, otherwise the default agent model                    |
| Ask your day     | The question, selected-day cards, and recent observations     | `textModel`, otherwise the default agent model                    |

The full SQLite database is not sent to either model. Raw screenshots go only
to the observation stage; card synthesis, standup, and Q&A receive derived
text.

### Run both stages locally with Ollama

Configure [Ollama](/providers/ollama) with `api: "ollama"` and a local
vision-capable model first. The OpenAI-compatible API is not used for this
structured extraction path. Enable the Ollama and Logbook plugins, then merge
these entries into your configuration:

```json5
{
  plugins: {
    entries: {
      ollama: { enabled: true },
      logbook: {
        enabled: true,
        config: {
          visionModel: "ollama/gemma4:12b",
          textModel: "ollama/gemma4:12b",
        },
        llm: {
          allowModelOverride: true,
          allowedCompletionModels: ["ollama/gemma4:12b"],
        },
      },
    },
  },
}
```

Replace the model reference in all three places if you use another local model.
If `plugins.allow` is set, include `logbook` and `ollama`. The Ollama base URL
must point to the local server; a Gateway in Docker uses the host address,
such as `http://host.docker.internal:11434`, instead of container localhost.
Do not select an Ollama cloud model for a local pipeline.

`allowModelOverride` permits Logbook's explicit text model. The
`allowedCompletionModels` allowlist also checks the resolved default model,
so an unset or incorrect text model fails instead of sending derived screen
content to a different provider. Other plugins and normal agent conversations
keep their existing model settings.

Restart the Gateway after applying the configuration. Capture some activity,
select **Analyze now**, and verify that a timeline card appears. Check
**Daily standup** and **Ask your day** as well: a successful observation pass
alone does not verify the text stage.

## Configuration

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
      logbook: {
        enabled: true,
        config: {
          captureEnabled: true,
          captureIntervalSeconds: 30,
          analysisIntervalMinutes: 15,
          nodeId: "my-mac",
          screenIndex: 0,
          maxWidth: 1440,
          visionModel: "codex/gpt-5.6-sol",
          retentionDays: 14,
        },
      },
    },
  },
}
```

All Logbook config keys are optional. Numeric values are rounded to integers
and clamped to the supported range.

| Key                       | Default | Range or values         | Behavior                                                                                                                           |
| ------------------------- | ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `captureEnabled`          | `true`  | boolean                 | Persistent master switch for new snapshots; the timeline remains available when `false`                                            |
| `captureIntervalSeconds`  | `30`    | `5`-`600`               | Delay between capture attempts                                                                                                     |
| `analysisIntervalMinutes` | `15`    | `3`-`120`               | Target observation window; gaps and midnight can close it earlier                                                                  |
| `nodeId`                  | unset   | node id or display name | Pins capture to one connected node; matching is case-insensitive                                                                   |
| `screenIndex`             | `0`     | `0`-`16`                | Zero-based display index                                                                                                           |
| `maxWidth`                | `1440`  | `480`-`3840`            | Requested capture size cap; headless macOS applies it to the largest dimension                                                     |
| `visionModel`             | unset   | `provider/model`        | Explicit structured route; malformed refs pause analysis, unsupported providers fail batches                                       |
| `textModel`               | unset   | `provider/model`        | Model for cards, repairs, standup, and Q&A; defaults to the agent model and requires plugin LLM model override permission when set |
| `retentionDays`           | `14`    | `1`-`365`               | Deletes completed observation frames; unfinished frames have at least seven days of grace; text remains                            |

Without `nodeId`, Logbook prefers a connected app node exposing
`screen.snapshot`, then falls back to a headless node exposing
`logbook.snapshot`. In an unpinned setup, a failed node rotates behind other
eligible nodes. The dashboard pause toggle is session-only and resets when the
Gateway restarts; use `captureEnabled: false` for a persistent stop.

### Change the captured display

`logbook.status` includes the active `screenIndex`. To save a different display
and apply it without restarting the Gateway:

```bash
openclaw gateway call logbook.screen.set --params '{"screenIndex":1}'
```

The method requires `operator.write` and accepts an integer from `0` to `16`.
It changes only `plugins.entries.logbook.config.screenIndex`, preserves the
current pause state, and returns status after the active configuration reflects
the choice. Gateway config reload must be enabled. A saved choice that cannot
be applied returns an error; refresh status before trying again.

This requires an existing Logbook `config` object. If the plugin has only
`enabled: true`, set `plugins.entries.logbook.config.screenIndex` and restart
once first. Creating the entire config object uses the broader plugin reload,
so this method rejects that initial setup instead of resetting a paused service.

The next capture uses the selected index. A capture already in progress keeps
its original index. On the native macOS app node, indices follow ascending
display IDs, not the main-display order. The headless capture command uses the
system `screencapture` display order. Recheck the selection after connecting or
disconnecting displays; the setting saves an index, not a physical-display ID.

### Vision model selection

Logbook resolves the observation model in this order:

1. `plugins.entries.logbook.config.visionModel`
2. the first image-capable Codex entry under `tools.media.models`

Borrowed defaults remain limited to Codex. Configure an explicit
`visionModel` to use Ollama structured extraction. Setting
`tools.media.image.enabled: false` disables borrowed media defaults, but an
explicit Logbook `visionModel` still applies.

## Dashboard tab

- **Timeline**: expandable cards per activity with category colors, the main
  app, distraction chips, and a snapshot keyframe.
- **Day at a glance**: focus ratio, category breakdown, top apps.
- **Daily standup**: turns yesterday plus today into a ready-to-paste update.
- **Ask your day**: natural-language questions answered from the tracked
  timeline ("when did I review the gateway PR?").
- **Analyze now**: closes the current capture window immediately instead of
  waiting for the analysis interval.

## Gateway methods

Logbook registers these Gateway RPC methods:

| Method                   | Parameters               | Scope            | Result                                                                        |
| ------------------------ | ------------------------ | ---------------- | ----------------------------------------------------------------------------- |
| `logbook.status`         | none                     | `operator.read`  | Capture, analysis, model, node, Gateway day, and Gateway timezone status      |
| `logbook.days`           | none                     | `operator.read`  | Days with timeline-card counts and card time bounds                           |
| `logbook.context`        | `{ day?, query? }`       | `operator.read`  | Bounded versioned context with source references and incomplete batches       |
| `logbook.context.delete` | `{ day: "YYYY-MM-DD" }`  | `operator.write` | Deletes source and derived records for the explicit day                       |
| `logbook.timeline`       | `{ day?: "YYYY-MM-DD" }` | `operator.read`  | Derived cards and day statistics; defaults to the Gateway's current day       |
| `logbook.frames`         | `{ startMs, endMs }`     | `operator.write` | Frame metadata in the requested epoch-millisecond range                       |
| `logbook.frame`          | `{ frameId }`            | `operator.write` | One raw JPEG frame as base64                                                  |
| `logbook.standup`        | `{ day?, refresh? }`     | `operator.write` | Cached or regenerated standup text for a day                                  |
| `logbook.ask`            | `{ day?, question }`     | `operator.write` | Timeline-grounded answer for a day                                            |
| `logbook.capture.set`    | `{ paused }`             | `operator.write` | Session-only pause state and updated status                                   |
| `logbook.screen.set`     | `{ screenIndex }`        | `operator.write` | Persistent display selection and updated status, without changing pause state |
| `logbook.analyze.now`    | none                     | `operator.write` | Starts pending analysis, or returns a reason it could not start               |

The read methods return operational state or derived text. Raw screenshot
pixels, model-spending actions, and runtime mutations require
`operator.write`. The Control UI tab also requires `operator.write` because it
exposes those actions and raw frame previews; a read-only client can still call
the derived-text methods directly.

## Work-resumption context

`logbook_context` lets the agent recall a day by date and an optional keyword
matching a target, activity, result, or other recorded text. It is available only
in a host-administrator private dashboard conversation, including sandboxed
agents. Channel conversations and conversations with an external delivery route
or native channel id do not receive it. Normal tool allow/deny policy still applies.
This is the existing host-global Logbook store, not a new per-profile database.

When that tool is authorized for a user turn, a recent context excerpt of at most
1,300 serialized characters is added to the prompt. Explicit retrieval returns
at most eight observations and 6,000 serialized characters, including provenance
and incomplete-batch metadata. The larger explicit result budget lets the agent
compare several records without injecting an entire day into every turn.
Truncation, total available records for the day (`availableRecords`), and query
match counts (`matchedRecords`) are reported. If a query matches zero records
but the day contains records, retry without the query before concluding there
is no context. Date defaults to the Gateway local day;
use an explicit date for earlier work.

Each new observation has context version `1` and these fields, each at most
160 characters:

| Field         | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `target`      | Visible app, project, document, or file          |
| `activity`    | Work actually visible in the sampled screenshots |
| `result`      | Visible result or change; empty when unknown     |
| `unresolved`  | Visibly unresolved issue; empty when unknown     |
| `uncertainty` | Ambiguous or unreadable evidence                 |

Record IDs and sample intervals come from the host, not model-generated clocks.
The host supplies `startTime` and `endTime` as ISO 8601 UTC strings ending in `Z`;
cite these values verbatim with their UTC timezone, without calculating clocks
from the accompanying epoch milliseconds. The date selector still uses the
Gateway local day.
These intervals describe samples, not continuous observation. Missing records
never prove inactivity or completion. Legacy free-text observations remain
searchable and are labeled unstructured rather than inventing structured facts.
Screen text is untrusted evidence, never authorization or instructions. This
feature does not infer permanent preferences or confirmed decisions.

Read context without invoking another model:

```bash
openclaw gateway call logbook.context --params '{"day":"2026-09-05","query":"editor"}'
```

Delete a day of source and derived records with an explicit date:

```bash
openclaw gateway call logbook.context.delete --params '{"day":"2026-09-05"}'
```

Deletion requires `operator.write` and is rejected during active capture,
analysis, or text generation. It removes that day's frames, observations,
batches, cards, and cached standup, and invalidates the following day's cached
standup because it can cite yesterday. Existing conversation transcripts and
external backups are separate artifacts and are not rewritten. To correct a
record without retaining its old derived interpretation, delete that day; this
first version does not provide individual-record editing. A failed deletion may
already have removed some image files. Source and derived metadata remain until
deletion completes successfully; explicitly retrying the same day safely
finishes deletion, including after a restart.

No additional runtime settings are required. Existing text retention is
preserved: observations and summaries do not automatically expire. Raw-image
retention stays bounded as described above. New nullable SQLite fields preserve
schema version 1 and older readers; back up state before installing a changed
runtime.

## Privacy notes

- Snapshots can contain anything on screen, including secrets. Frames never
  leave the machine except as sampled input to the configured observation
  model.
- Observations, recent cards, and questions can leave the machine through
  `textModel` or the default agent model during card synthesis, standup generation, or Q&A. Apply
  the provider's data-handling policy to both model routes.
- Use local routes for both the structured observation model and text model
  when you need a fully local pipeline. Restrict the plugin's completion model
  allowlist as shown above.
- Normal-conversation recall sends derived context to that conversation's model.
  The Logbook completion-model allowlist does not control the normal chat model.
  Use a local chat model or deny `logbook_context` if that text must remain local.
- The observation prompt omits credentials and unrelated private conversations;
  this is not guaranteed pixel-level redaction. Pause capture before sensitive
  work. Per-app/site exclusions and automatic secret detection are not provided
  by this version.
- Frames, the timeline database, and temporary captures are written with
  owner-only file permissions.
- Adding `screen.snapshot` to `gateway.nodes.commands.deny` is the
  screen-capture kill switch: it blocks app-node capture and Logbook's own
  `logbook.snapshot` command alike.
- Setting `tools.media.image.enabled: false` also stops Logbook from borrowing
  the media image models for analysis; only an explicit `visionModel` in the
  plugin config is used then.

## Troubleshooting

### The Logbook tab is missing

Check all three gates:

1. `openclaw plugins list --enabled` includes `logbook`.
2. The Gateway restarted after the plugin or allowlist change.
3. The Control UI connection has `operator.write`; read-only sessions do not
   receive the interactive tab descriptor.

If `plugins.allow` is set, it must include both `logbook` and `codex` for the
recommended configuration.

### Capture reports an error

```bash
openclaw nodes status --connected
openclaw nodes describe --node <idOrNameOrIp>
openclaw logs --follow
```

- Confirm the node exposes `screen.snapshot` or `logbook.snapshot`.
- Grant Screen Recording permission on the capture Mac.
- If `nodeId` is configured, confirm it matches the node id or display name.
- Check that `gateway.nodes.commands.deny` does not contain
  `screen.snapshot`.

After three consecutive failures, Logbook backs off for ten capture ticks and
then retries. An unpinned setup can rotate to another eligible node.

### Captures succeed but no cards appear

- A **Model missing** status means no compatible structured vision route was
  found. Enable and authenticate the Codex plugin, or set a valid explicit
  `visionModel`. Captured frames remain pending while the model is missing and
  can be analyzed after configuration is fixed.
- Wait for `analysisIntervalMinutes`, or select **Analyze now** after activity
  has been captured.
- Consecutive identical frames are idle evidence and do not enter analysis
  batches. Change the visible screen before testing.
- If the latest batch shows an error, fix the model or auth problem and select
  **Analyze now** after the bounded automatic retry budget is exhausted.
  Explicit retry renews the budget but preserves completed observation chunks.
  Expired or missing source frames cannot be reconstructed by retrying.

## Related

- [Manage plugins](/plugins/manage-plugins)
- [Codex harness](/plugins/codex-harness)
- [Media understanding](/nodes/media-understanding)
- [Nodes](/nodes)
- [Node troubleshooting](/nodes/troubleshooting)
- [Control UI](/web/control-ui)
