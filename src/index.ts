import type { Plugin as PluginV1 } from "@opencode-ai/plugin"
import type { Plugin as PluginV2NS } from "@opencode/plugin"

type PluginV2 = PluginV2NS.Plugin
import { countTokens as countTokensCl100k } from "gpt-tokenizer"
import { countTokens as countTokensO200k } from "gpt-tokenizer/encoding/o200k_base"

/* eslint-disable @typescript-eslint/no-explicit-any */
declare function require(id: string): any
declare const process: { env: { HOME?: string } }

// ── Lazy-loaded modules (required once, cached by Node/Bun) ──────────────
let _fs: any = null
let _path: any = null
const fs = () => _fs ?? (_fs = require("fs"))
const path = () => _path ?? (_path = require("path"))

// ── Plugin version (synced with package.json) ────────────────────────────
const PLUGIN_VERSION = "0.0.7"

/**
 * Session Title Filter Plugin options.
 */
export interface SessionTitleFilterOptions {
  /**
   * Print debug logs to stderr and a log file.
   * @default false
   */
  debug?: boolean
  /**
   * Keep only the title-generation prompt and strip every other system entry.
   * Set to false to disable filtering (debug-only mode).
   * @default true
   */
  enabled?: boolean
  /**
   * Show a TUI toast immediately after calculating token savings.
   * Only effective on the opencode v1 API — v2 server plugins have no TUI
   * toast API, so savings are logged instead.
   * @default true
   */
  notify?: boolean
}

/** Options after applying defaults. */
interface ResolvedOptions {
  readonly debug: boolean
  readonly enabled: boolean
  readonly notify: boolean
}

const resolveOptions = (options: SessionTitleFilterOptions = {}): ResolvedOptions => ({
  debug: options.debug === true,
  enabled: options.enabled !== false,
  notify: options.notify !== false,
})

/**
 * Marker string that uniquely identifies opencode's built-in title agent prompt.
 * Source: packages/core/src/plugin/agent.ts -> PROMPT_TITLE
 *   "You are a title generator. You output ONLY a thread title. Nothing else."
 *
 * Verified identical in opencode v1 (main) and v2 (dev branch).
 *
 * Must use the FULL first line (not just "You are a title generator") because
 * other agents' system prompts may reference this string in comments, e.g.:
 *   `"You are a title generator"` - 来自 opencode core ...
 * The full sentence with ". You output ONLY" only appears in the actual
 * PROMPT_TITLE, never in comments or cross-references.
 */
const TITLE_MARKER = "You are a title generator. You output ONLY a thread title. Nothing else."

/**
 * PROMPT_TITLE ends with a closing </examples> tag. Anything after it inside
 * the same system string is content appended by other plugins (magic-context,
 * instruction files, etc.) and is safe to strip for title generation.
 */
const TITLE_PROMPT_END = "</examples>"

/** TUI toast display duration (ms), v1 API only. */
const TOAST_DURATION_MS = 5000
/** How long to remember a session has already toasted (ms), to prevent
 * duplicate toasts from LLM retries. */
const TOAST_DEDUP_MS = 60_000
/** Max number of system dump files to keep in debug mode. */
const MAX_DUMP_FILES = 10

/**
 * Select the correct tokenizer encoding for a given model.
 *
 * gpt-tokenizer defaults to cl100k_base (GPT-4 / GPT-3.5). GPT-4o family
 * and o1/o3 reasoning models use o200k_base. Non-OpenAI models (Claude,
 * Gemini, etc.) have no public JS tokenizer; cl100k_base is used as a
 * close approximation (typically within ±5% for English/code text).
 */
const isO200kModel = (modelID: string): boolean => {
  const id = modelID.toLowerCase()
  return id.includes("4o") || /^o[13]\b/.test(id) || id.includes("chatgpt-4o")
}
const pickTokenCounter = (modelID: string): ((text: string) => number) =>
  isO200kModel(modelID) ? countTokensO200k : countTokensCl100k

/**
 * Extract the pure PROMPT_TITLE from a system text that may have other
 * content prepended or appended by other plugins.
 *
 * @returns The substring from TITLE_MARKER to TITLE_PROMPT_END (inclusive).
 *          If either marker is missing, returns the original text unchanged
 *          (safe fallback — no stripping).
 */
const extractPureTitle = (text: string): string => {
  const startIdx = text.indexOf(TITLE_MARKER)
  if (startIdx === -1) return text
  const endIdx = text.indexOf(TITLE_PROMPT_END, startIdx)
  if (endIdx === -1) return text
  return text.slice(startIdx, endIdx + TITLE_PROMPT_END.length)
}

type LogFn = (...args: unknown[]) => void

/**
 * Shared stderr + log-file logger. Inactive unless debug is on.
 */
const createLogger = (debug: boolean): { logDir: string | null; log: LogFn } => {
  const logDir = (() => {
    try {
      const d = path().join(process.env.HOME || "", ".local/share/opencode/log")
      fs().mkdirSync(d, { recursive: true })
      return d
    } catch {
      return null
    }
  })()

  const log: LogFn = (...args: unknown[]) => {
    if (!debug) return
    const msg = `[session-title-filter] ${args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")}\n`
    console.error("[session-title-filter]", ...args)
    if (logDir) {
      try {
        fs().appendFileSync(path().join(logDir, "session-title-filter.log"), msg)
      } catch {}
    }
  }

  return { logDir, log }
}

/**
 * Clean up old system dump files, keeping only the most recent MAX_DUMP_FILES.
 * Only called in debug mode.
 */
function cleanupDumpFiles(logDir: string): void {
  try {
    const entries = fs().readdirSync(logDir) as string[]
    const dumps = entries
      .filter((f) => f.startsWith("session-title-filter-system-") && f.endsWith(".txt"))
      .sort()
    if (dumps.length <= MAX_DUMP_FILES) return
    for (const old of dumps.slice(0, dumps.length - MAX_DUMP_FILES)) {
      try { fs().unlinkSync(path().join(logDir, old)) } catch {}
    }
  } catch {}
}

/**
 * Minimal shape of the opencode v1 SDK client surface we use.
 *   tui.showToast: { body: { title?, message, variant, duration? } }
 */
type ClientLike = {
  tui: {
    showToast: (params: {
      body: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
    }) => Promise<unknown>
  }
}

/**
 * Show a toast immediately with the token savings (v1 API only). No polling
 * needed - savedTokens is already computed before the LLM call.
 *
 * Dedup: `toastedSessions` prevents duplicate toasts when the LLM call is
 * retried (each retry fires the hook -> another toast attempt).
 */
const toastedSessions = new Set<string>()

async function showToastImmediate(
  input: { client: ClientLike },
  sessionID: string,
  savedTokens: number,
  log: LogFn,
): Promise<void> {
  if (savedTokens <= 0) {
    log("notify: savedTokens <= 0, skipping toast")
    return
  }
  if (toastedSessions.has(sessionID)) {
    log("notify: toast already shown for session, skipping duplicate")
    return
  }
  toastedSessions.add(sessionID)
  setTimeout(() => toastedSessions.delete(sessionID), TOAST_DEDUP_MS)

  const message = `Title call saved ${savedTokens} tokens`
  try {
    await input.client.tui.showToast({
      body: {
        title: "Session title filter",
        message,
        variant: "success",
        duration: TOAST_DURATION_MS,
      },
    })
    log("notify: toast shown, savedTokens:", savedTokens)
  } catch (e) {
    log("notify: showToast failed:", e)
  }
}

// ── opencode v2 API ──────────────────────────────────────────────────────
//
// V2 plugins default-export an object with a stable `id` and `setup(ctx)`.
// The dedicated `title` session hook fires only for title-generation
// requests, so detection is structural (no content sniffing needed to find
// the call). The system payload is `Array<SystemPart>` where every part is
// `{ type: "text", text, cache?, metadata? }`; opencode core initializes it
// to exactly `[SystemPart.make(PROMPT_TITLE)]` (packages/core/src/session/
// title.ts), and other plugins' `title` hooks may append more parts before
// or after ours — content markers are still used to locate the pure
// PROMPT_TITLE inside the concatenated text.

/**
 * Minimal structural type for opencode v2 system parts
 * (`SystemPart` from @opencode/ai is `{ type: "text", text, cache?, metadata? }`).
 */
interface TextSystemPart {
  type: "text"
  text: string
  cache?: unknown
  metadata?: unknown
}

/**
 * Strip every system part that is irrelevant to title generation, in place.
 *
 * Keeps only the pure PROMPT_TITLE extracted from the part containing
 * TITLE_MARKER. If no part contains the marker (opencode changed the title
 * agent prompt), this is a safe no-op.
 */
function filterTitleSystemParts(
  system: TextSystemPart[],
  modelID: string,
  resolved: ResolvedOptions,
  log: LogFn,
  logDir: string | null,
): void {
  const texts = system.map((p) => (p != null && typeof p.text === "string" ? p.text : ""))
  const titleIndex = texts.findIndex((t) => t.includes(TITLE_MARKER))
  if (titleIndex === -1) {
    log(
      "title hook fired but TITLE_MARKER not found in any system part;",
      "opencode may have changed PROMPT_TITLE - update TITLE_MARKER in src/index.ts. no-op.",
    )
    return
  }
  if (!resolved.enabled) {
    log("title generation detected (disabled, no filtering), system parts:", system.length)
    return
  }

  const countTokens = pickTokenCounter(modelID)

  // ── Detailed debug: dump every system part ──
  if (resolved.debug && logDir) {
    cleanupDumpFiles(logDir)
    for (let i = 0; i < system.length; i++) {
      const entry = texts[i]
      log(`  system[${i}]: len=${entry.length} head=${JSON.stringify(entry.slice(0, 120))} tail=${JSON.stringify(entry.slice(-120))}`)
      try {
        const dumpPath = path().join(logDir, `session-title-filter-system-${i}-${Date.now()}.txt`)
        fs().writeFileSync(dumpPath, entry)
        log(`  system[${i}]: full dump written to ${dumpPath}`)
      } catch (e) {
        log(`  system[${i}]: dump failed:`, e)
      }
    }
  }

  const originalText = texts.filter(Boolean).join("\n")
  const originalTokens = countTokens(originalText)

  log(
    "title call: model:", modelID || "unknown",
    "parts:", system.length,
    "titleIndex:", titleIndex,
    "originalText.len:", originalText.length,
    "originalTokens:", originalTokens,
  )

  const pureTitle = extractPureTitle(texts[titleIndex])
  system.length = 0
  system.push({ type: "text", text: pureTitle })

  const filteredTokens = countTokens(pureTitle)
  const savedTokens = Math.max(0, originalTokens - filteredTokens)

  log(
    "filtered: pureTitle.len:", pureTitle.length,
    "pureTitle.head:", JSON.stringify(pureTitle.slice(0, 80)),
    "filteredTokens:", filteredTokens,
    "savedTokens:", savedTokens,
  )
}

/**
 * opencode v2 plugin definition. Registered via the dual entrypoint below.
 */
const v2Definition: PluginV2 = {
  id: "session-title-filter",
  setup: async (ctx) => {
    const resolved = resolveOptions(ctx.options as SessionTitleFilterOptions)
    const { logDir, log } = createLogger(resolved.debug)
    log(
      `plugin v${PLUGIN_VERSION} loaded (opencode v2 API), enabled:`, resolved.enabled,
      "notify:", resolved.notify,
    )
    if (resolved.notify) {
      log("notify: opencode v2 server plugins have no TUI toast API; savings are logged only")
    }

    await ctx.session.hook("title", (event) => {
      try {
        const modelID = event.model?.id ?? ""
        filterTitleSystemParts(event.system as TextSystemPart[], modelID, resolved, log, logDir)
      } catch (e) {
        log("title hook error:", e)
      }
    })
  },
}

// ── opencode v1 API ──────────────────────────────────────────────────────

/**
 * Strip every system-prompt injection that is irrelevant to title generation
 * (opencode v1 API).
 *
 * Title generation is a background LLM call that only needs the fixed
 * PROMPT_TITLE. Other plugins (magic-context, oh-my-opencode-slim, project
 * AGENTS.md, skill guidance, ...) hook `experimental.chat.system.transform`
 * and append project memory, session history, skill listings, etc. That
 * content is useless for producing a 50-char title and wastes tokens on
 * every new session.
 *
 * Detection: the title agent's prompt is a constant that contains
 * "You are a title generator. You output ONLY a thread title. Nothing else."
 * When the hook fires and any system string contains that full sentence, we
 * know this LLM call is title generation.
 */
export const SessionTitleFilterPlugin: PluginV1 = async (input, options: SessionTitleFilterOptions = {}) => {
  const resolved = resolveOptions(options)
  const { logDir, log } = createLogger(resolved.debug)

  log(`plugin v${PLUGIN_VERSION} loaded (opencode v1 API), enabled:`, resolved.enabled, "notify:", resolved.notify)

  const systemTransform: NonNullable<
    Awaited<ReturnType<PluginV1>>["experimental.chat.system.transform"]
  > = async (hookInput, hookOutput) => {
    try {
      const system = (hookOutput as { system: string[] }).system
      if (!Array.isArray(system) || system.length === 0) return

      const titleIndex = system.findIndex(
        (s) => typeof s === "string" && s.includes(TITLE_MARKER),
      )
      if (titleIndex === -1) return

      if (!resolved.enabled) {
        log("title generation detected (disabled, no filtering), system entries:", system.length)
        return
      }

      const modelInfo = (hookInput as { model?: { id?: string } })?.model
      const modelID = modelInfo?.id ?? ""
      const countTokens = pickTokenCounter(modelID)

      // ── Detailed debug: dump every system entry ──
      if (resolved.debug && logDir) {
        cleanupDumpFiles(logDir)
        for (let i = 0; i < system.length; i++) {
          const entry = system[i]
          if (typeof entry !== "string") {
            log(`  system[${i}]: <non-string ${typeof entry}>`)
            continue
          }
          const head = entry.slice(0, 120)
          const tail = entry.slice(-120)
          log(`  system[${i}]: len=${entry.length} head=${JSON.stringify(head)} tail=${JSON.stringify(tail)}`)

          // Dump full entry to separate file for inspection
          try {
            const dumpPath = path().join(logDir, `session-title-filter-system-${i}-${Date.now()}.txt`)
            fs().writeFileSync(dumpPath, entry)
            log(`  system[${i}]: full dump written to ${dumpPath}`)
          } catch (e) {
            log(`  system[${i}]: dump failed:`, e)
          }
        }
      }

      const originalText = system
        .filter((s): s is string => typeof s === "string")
        .join("\n")
      const originalTokens = countTokens(originalText)

      log(
        "title call: model:", modelID || "unknown",
        "entries:", system.length,
        "titleIndex:", titleIndex,
        "originalText.len:", originalText.length,
        "originalTokens:", originalTokens,
      )

      const pureTitle = extractPureTitle(system[titleIndex] as string)
      system.length = 0
      system.push(pureTitle)

      const filteredTokens = countTokens(pureTitle)
      const savedTokens = Math.max(0, originalTokens - filteredTokens)

      log(
        "filtered: pureTitle.len:", pureTitle.length,
        "pureTitle.head:", JSON.stringify(pureTitle.slice(0, 80)),
        "filteredTokens:", filteredTokens,
        "savedTokens:", savedTokens,
      )

      if (resolved.notify) {
        const sessionID = (hookInput as { sessionID?: string })?.sessionID
        if (sessionID) {
          showToastImmediate(
            input as unknown as { client: ClientLike },
            sessionID, savedTokens, log,
          ).catch((e) => log("notify: error:", e))
        } else {
          log("notify: no sessionID in hook input, skipping toast")
        }
      }
    } catch (e) {
      log("system.transform error:", e)
    }
  }

  return {
    "experimental.chat.system.transform": systemTransform,
  }
}

// ── Dual entrypoint: one package, both opencode generations ───────────────
//
// Per the official migration guide (opencode.ai/v2/docs/build/plugins/
// migrate-v1), a package can temporarily expose both implementations from
// one default export: opencode v2 calls `setup()`, opencode v1 (>= 1.18.29)
// calls `server()`. Plugin.define is an identity function, so spreading the
// plain definition object is equivalent and keeps @opencode/plugin a
// type-only dependency (zero runtime deps beyond gpt-tokenizer).

const dualEntrypoint: PluginV2 & { server: typeof SessionTitleFilterPlugin } = {
  ...v2Definition,
  server: SessionTitleFilterPlugin,
}

export default dualEntrypoint
