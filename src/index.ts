import type { Plugin } from "@opencode-ai/plugin"
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
const PLUGIN_VERSION = "0.0.5"

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
   * @default true
   */
  notify?: boolean
}

/**
 * Marker string that uniquely identifies opencode's built-in title agent prompt.
 * Source: packages/core/src/plugin/agent.ts -> PROMPT_TITLE
 *   "You are a title generator. You output ONLY a thread title. Nothing else."
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

/** TUI toast display duration (ms). */
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
 * Extract the pure PROMPT_TITLE from a system entry that may have other
 * content prepended or appended by other plugins.
 *
 * @returns The substring from TITLE_MARKER to TITLE_PROMPT_END (inclusive).
 *          If either marker is missing, returns the original entry unchanged
 *          (safe fallback — no stripping).
 */
const extractPureTitle = (entry: string): string => {
  const startIdx = entry.indexOf(TITLE_MARKER)
  if (startIdx === -1) return entry
  const endIdx = entry.indexOf(TITLE_PROMPT_END, startIdx)
  if (endIdx === -1) return entry
  return entry.slice(startIdx, endIdx + TITLE_PROMPT_END.length)
}

/**
 * Minimal shape of the opencode SDK client surface we use.
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
 * Show a toast immediately with the token savings. No polling needed -
 * savedTokens is already computed in system.transform before the LLM call.
 *
 * Dedup: `toastedSessions` prevents duplicate toasts when the LLM call is
 * retried (each retry fires system.transform -> another toast attempt).
 */
const toastedSessions = new Set<string>()

async function showToastImmediate(
  input: { client: ClientLike },
  sessionID: string,
  savedTokens: number,
  log: (...args: unknown[]) => void,
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
 * Strip every system-prompt injection that is irrelevant to title generation.
 *
 * Title generation is a background LLM call that only needs the fixed
 * PROMPT_TITLE. Other plugins (magic-context, oh-my-opencode-slim, project
 * AGENTS.md, skill guidance, ...) hook `experimental.chat.system.transform`
 * and append project memory, session history, skill listings, etc. That
 * content is useless for producing a 50-char title and wastes tokens on
 * every new session.
 *
 * Detection: the title agent's prompt is a constant that begins with
 * "You are a title generator. You output ONLY a thread title. Nothing else."
 * When the hook fires and any system string contains that full sentence, we
 * know this LLM call is title generation.
 */
export const SessionTitleFilterPlugin: Plugin = async (input, options: SessionTitleFilterOptions = {}) => {
  const debug = options.debug === true
  const enabled = options.enabled !== false
  const notify = options.notify !== false

  const logDir = (() => {
    try {
      const d = path().join(process.env.HOME || "", ".local/share/opencode/log")
      fs().mkdirSync(d, { recursive: true })
      return d
    } catch {
      return null
    }
  })()

  const log = (...args: unknown[]) => {
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

  log(`plugin v${PLUGIN_VERSION} loaded, enabled:`, enabled, "notify:", notify)

  const systemTransform: NonNullable<
    Awaited<ReturnType<Plugin>>["experimental.chat.system.transform"]
  > = async (hookInput, hookOutput) => {
    try {
      const system = (hookOutput as { system: string[] }).system
      if (!Array.isArray(system) || system.length === 0) return

      const titleIndex = system.findIndex(
        (s) => typeof s === "string" && s.includes(TITLE_MARKER),
      )
      if (titleIndex === -1) return

      if (!enabled) {
        log("title generation detected (disabled, no filtering), system entries:", system.length)
        return
      }

      const modelInfo = (hookInput as { model?: { id?: string } })?.model
      const modelID = modelInfo?.id ?? ""
      const countTokens = pickTokenCounter(modelID)

      // ── Detailed debug: dump every system entry ──
      if (debug && logDir) {
        if (debug) cleanupDumpFiles(logDir)
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

      if (notify) {
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

export default SessionTitleFilterPlugin
