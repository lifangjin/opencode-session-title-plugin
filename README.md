# @lifangjin/opencode-session-title-plugin

[![npm version](https://img.shields.io/npm/v/@lifangjin/opencode-session-title-plugin.svg)](https://www.npmjs.com/package/@lifangjin/opencode-session-title-plugin)

English | [简体中文](./README.zh-CN.md)

Filter irrelevant system-prompt injections from opencode session title generation to save tokens.

## Why

Every new opencode session triggers a background LLM call that generates a short title. The call uses opencode's built-in `title` agent, whose prompt is a fixed ~1KB string ending in `</examples>`:

```
You are a title generator. You output ONLY a thread title. Nothing else.
...
```

Other plugins (`@cortexkit/opencode-magic-context`, `oh-my-opencode-slim`, project `AGENTS.md`, skill guidance, MCP instructions, ...) hook `experimental.chat.system.transform` and append project memory, session history, skill listings, and other context to **every** LLM call — including title generation. That context is useless for producing a 50-character title and wastes thousands of tokens on every new session.

This plugin detects title-generation calls and strips the system prompt back to just `PROMPT_TITLE`, so the small model only sees what it actually needs.

## How it works

The plugin hooks:

- `experimental.chat.system.transform` — when any system string contains the marker `"You are a title generator"`, it replaces the entire system array with the extracted `PROMPT_TITLE` (everything up to and including `</examples>`), dropping every other entry.
- `experimental.chat.messages.transform` — when the user message contains `"Generate a title for this conversation"` (the title-agent prefix), it drops any `system`/`developer`-role messages other plugins injected.

Detection is content-based because `experimental.chat.system.transform` receives `{ sessionID, model }` (no agent name) and `experimental.chat.messages.transform` receives `{}`. The title agent's prompt is a constant in opencode core (`packages/core/src/plugin/agent.ts`), so the markers are stable.

## Install

### As a published package

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "@lifangjin/opencode-session-title-plugin"
  ]
}
```

### With options

```jsonc
{
  "plugin": [
    ["@lifangjin/opencode-session-title-plugin", { "debug": true }]
  ]
}
```

### From source (local dev)

1. Build:

   ```sh
   bun install
   bun run build
   ```

2. Symlink into opencode's plugin directory:

   ```sh
   ln -s "$(pwd)" ~/.config/opencode/plugins/opencode-session-title-plugin
   ```

   Or copy the built entry:

   ```sh
   cp dist/index.js ~/.config/opencode/plugins/opencode-session-title-plugin.js
   ```

3. Register in `opencode.json`:

   ```jsonc
   {
     "plugin": ["./plugins/opencode-session-title-plugin.js"]
   }
   ```

## Options

| Option            | Type      | Default | Description                                                                |
| ----------------- | --------- | ------- | -------------------------------------------------------------------------- |
| `debug`           | `boolean` | `false` | Print detection and filtering decisions to stderr.                         |
| `enabled`         | `boolean` | `true`  | Master switch. Set `false` to detect-only (no mutation).                   |
| `filterMessages`  | `boolean` | `true`  | Also filter `experimental.chat.messages.transform` system entries.         |
| `notify`          | `boolean` | `true`  | Show a TUI toast when the title is generated, reporting tokens saved.      |
| `notifyTimeout`   | `number`  | `30`    | Max seconds to poll for the generated title before giving up the toast.    |

### Title-ready toast

When `notify` is on (default), the plugin polls `session.get` after filtering and fires a `tui.showToast` once the title flips from its default to a real value:

```
Session title ready
"<generated title>" | title call saved ~1234 tokens
```

The hook fires before the LLM call, so the plugin cannot synchronously know the finished title - it polls once per second up to `notifyTimeout`. Token savings are estimated as `(original_system_chars - filtered_chars) / 4` and rounded. The toast uses opencode's SDK `client.tui.showToast` API, which only renders when a TUI is connected (headless runs silently skip).

## Using a cheaper model for title generation

This plugin only filters the system prompt. Which model opencode calls for title generation is controlled by opencode itself - no plugin hook can override it (`experimental.chat.system.transform` receives `model` read-only; the prepare closure uses the original).

opencode's title-agent model priority (source: `SessionPrompt.ensureTitle` in `packages/opencode/src/session/prompt.ts`):

1. `agent.title.model` - set on the built-in `title` agent via config (highest priority)
2. `small_model` - global lightweight model config
3. main session model - the fallback (most expensive)

To pin a cheap model for title generation only, add it to `opencode.json`:

```jsonc
{
  "agent": {
    "title": {
      "model": "omlx/Qwen3.6-35B-A3B-8bit"
    }
  }
}
```

The `model` value is a `"provider/model-id"` string referencing a provider already configured in `opencode.json`. This pairs naturally with this plugin: the cheap model sees only `PROMPT_TITLE` (plugin strips the rest), so token cost per title drops to near zero.

To use one cheap model for all lightweight tasks (title, summarization, compaction) instead, set `small_model` at the top level:

```jsonc
{
  "small_model": "omlx/Qwen3.6-35B-A3B-8bit"
}
```

Verify the active model in the opencode log: the `stream` line's `modelID` field should show the configured model when a new session is created.

## Verification

Start a new opencode session. With `debug: true`, check the opencode log for:

```
[session-title-filter] title generation detected, original system entries: N sizes: [...]
[session-title-filter] filtered system entries: 1 total chars: ~1200
```

`total chars` should be around 1200 (the size of `PROMPT_TITLE`). If it is much larger, other plugins are still injecting into the same system string — open an issue with the log output.

## Compatibility

- opencode with `@opencode-ai/plugin` >= 1.4.0
- Hooks used: `experimental.chat.system.transform`, `experimental.chat.messages.transform`
- The detection marker (`"You are a title generator"`) is tied to opencode's built-in `PROMPT_TITLE`. If opencode changes the title-agent prompt, update `TITLE_MARKER` in `src/index.ts`.

## License

MIT
