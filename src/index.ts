import type { Plugin } from "@opencode-ai/plugin"
import { countTokens as countTokensCl100k } from "gpt-tokenizer"
import { countTokens as countTokensO200k } from "gpt-tokenizer/encoding/o200k_base"

/**
 * Session Title Filter Plugin options.
 */
export interface SessionTitleFilterOptions {
  /**
   * Print debug logs to stderr (visible in opencode logs).
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
   * Also filter `experimental.chat.messages.transform` to drop system-role
   * messages injected by other plugins when generating a title.
   * @default true
   */
  filterMessages?: boolean
  /**
   * Show a TUI toast when title generation completes, reporting the generated
   * title and approximate tokens saved. Uses opencode's `tui.showToast` API
   * via the plugin SDK client.
   * @default true
   */
  notify?: boolean
  /**
   * Max seconds to poll for the generated title before giving up the toast.
   * Title generation is async; the hook fires before the LLM call, so the
   * plugin polls `session.get` until the title changes.
   * @default 30
   */
  notifyTimeout?: number
}

/**
 * Marker string that uniquely identifies opencode's built-in title agent prompt.
 * Source: packages/core/src/plugin/agent.ts -> PROMPT_TITLE
 *   "You are a title generator. You output ONLY a thread title. Nothing else."
 */
const TITLE_MARKER = "You are a title generator"

/**
 * PROMPT_TITLE ends with a closing </examples> tag. Anything after it inside
 * the same system string is content appended by other plugins (magic-context,
 * instruction files, etc.) and is safe to strip for title generation.
 */
const TITLE_PROMPT_END = "</examples>"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

/** Polling interval (ms) for monitorTitleAndNotify. */
const POLL_INTERVAL_MS = 1000
/** Polling max interval (ms) for monitorTitleAndNotify (exponential backoff cap). */
const POLL_MAX_INTERVAL_MS = 5000
/** TUI toast display duration (ms). */
const TOAST_DURATION_MS = 5000
/** How long to remember a session has already toasted (ms), to prevent
 * duplicate toasts from LLM retries. */
const TOAST_DEDUP_MS = 60_000

/**
 * opencode sets a default title on new sessions before the title agent runs.
 * Heuristic reconstruction of opencode's `Session.isDefaultTitle` — matches
 * uuid-ish session IDs, empty strings, and common default labels. This is a
 * best-effort guess and may drift from opencode's actual defaults; if a real
 * title ever matches one of these patterns the toast would be skipped.
 * Source: SessionPrompt.ensureTitle skips when `!Session.isDefaultTitle`.
 */
const DEFAULT_TITLE_PATTERNS = ["new session", "new conversation", "untitled", "untitled session"]
const isDefaultTitle = (title: unknown): boolean => {
  if (typeof title !== "string") return true
  if (title.length === 0) return true
  // uuid-ish session IDs (full match)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)) return true
  return DEFAULT_TITLE_PATTERNS.includes(title.toLowerCase())
}

/**
 * Minimal shape of the opencode SDK client surface we use. The real client is
 * `ReturnType<typeof createOpencodeClient>`; we narrow to the two methods we
 * call so the plugin stays decoupled from SDK version drift.
 *
 * SDK parameter shapes (from @opencode-ai/sdk gen types):
 *   session.get:   { path: { id: string }, query?: { directory?: string } }
 *   tui.showToast: { body: { title?, message, variant, duration? } }
 * URL templates: "/session/{id}", "/tui/show-toast".
 */
type ClientLike = {
  session: {
    get: (params: { path: { id: string } }) => Promise<{
      data?: { title?: string }
    }>
  }
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
 * After the system.transform hook strips irrelevant injections, title
 * generation runs async in the background. Poll session.get approximately
 * every POLL_INTERVAL_MS (plus RPC latency) until the title flips from its
 * default to a real value, then fire a TUI toast.
 *
 * Dedup: `toastedSessions` prevents duplicate toasts when the LLM call is
 * retried (each retry fires system.transform → messages.transform → another
 * monitor). Once a toast has been shown for a session, subsequent monitors
 * exit silently.
 */
const toastedSessions = new Set<string>()

async function monitorTitleAndNotify(
  input: { client: ClientLike },
  sessionID: string,
  savedTokens: number,
  timeoutSec: number,
  log: (...args: unknown[]) => void,
): Promise<void> {
  if (toastedSessions.has(sessionID)) {
    log("notify: toast already shown for session, skipping duplicate")
    return
  }

  let initialTitle: string | undefined
  try {
    const res = await input.client.session.get({ path: { id: sessionID } })
    initialTitle = res?.data?.title
  } catch (e) {
    log("notify: failed to get initial session:", e)
    return
  }

  const deadline = Date.now() + timeoutSec * 1000
  let delay = POLL_INTERVAL_MS
  while (Date.now() < deadline) {
    await sleep(delay)
    delay = Math.min(delay * 2, POLL_MAX_INTERVAL_MS)
    try {
      const res = await input.client.session.get({ path: { id: sessionID } })
      const title = res?.data?.title
      if (title && title !== initialTitle && !isDefaultTitle(title)) {
        if (toastedSessions.has(sessionID)) {
          log("notify: toast already shown by a concurrent monitor, skipping")
          return
        }
        toastedSessions.add(sessionID)
        setTimeout(() => toastedSessions.delete(sessionID), TOAST_DEDUP_MS)

        const message =
          savedTokens > 0
            ? `"${title}" | title call saved ${savedTokens} tokens`
            : `"${title}" generated with stripped system prompt`
        try {
          await input.client.tui.showToast({
            body: {
              title: "Session title ready",
              message,
              variant: "success",
              duration: TOAST_DURATION_MS,
            },
          })
          log("notify: toast shown for title:", title, "savedTokens:", savedTokens)
        } catch (e) {
          log("notify: showToast failed:", e)
        }
        return
      }
    } catch (e) {
      log("notify: poll error:", e)
    }
  }
  log("notify: timeout after", timeoutSec, "s, title not generated")
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
 * "You are a title generator". When the hook fires and any system string
 * contains that marker, we know this LLM call is title generation.
 */
export const SessionTitleFilterPlugin: Plugin = async (input, options: SessionTitleFilterOptions = {}) => {
  const debug = options.debug === true
  const enabled = options.enabled !== false
  const notify = options.notify !== false
  const notifyTimeout = options.notifyTimeout && options.notifyTimeout > 0 ? options.notifyTimeout : 30

  const log = debug
    ? (...args: unknown[]) => console.error("[session-title-filter]", ...args)
    : () => {}

  log("plugin v0.0.4 loaded, enabled:", enabled, "notify:", notify)

  const extractPureTitle = (entry: string): string => {
    // opencode 在 LLMRequestPrep.prepare 中先把 agent.prompt + e.system +
    // user.system 用 "\n" join 成单个字符串再放入 system 数组（初始 length=1）。
    // 其他 plugin（magic-context、oh-my-opencode-slim 等）还可能往 system 里
    // push 新 entry 或修改已有 entry。因此 PROMPT_TITLE 不一定在 entry 开头。
    // 用 indexOf 定位 TITLE_MARKER 在 entry 中的任意起点，再找 TITLE_PROMPT_END
    // 终点，slice 出纯 PROMPT_TITLE 段。
    const startIdx = entry.indexOf(TITLE_MARKER)
    if (startIdx === -1) return entry
    const endIdx = entry.indexOf(TITLE_PROMPT_END, startIdx)
    if (endIdx === -1) {
      log("PROMPT_TITLE_END not found, marker may have drifted; plugin ineffective for this call")
      return entry
    }
    return entry.slice(startIdx, endIdx + TITLE_PROMPT_END.length)
  }

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

      // Read model from hook input to select the correct tokenizer encoding.
      const modelInfo = (hookInput as { model?: { id?: string } })?.model
      const modelID = modelInfo?.id ?? ""
      const countTokens = pickTokenCounter(modelID)

      // ── Detailed debug: dump every system entry ──
      for (let i = 0; i < system.length; i++) {
        const entry = system[i]
        if (typeof entry !== "string") {
          log(`  system[${i}]: <non-string ${typeof entry}>`)
          continue
        }
        const head = entry.slice(0, 120)
        const tail = entry.slice(-120)
        log(`  system[${i}]: len=${entry.length} head=${JSON.stringify(head)} tail=${JSON.stringify(tail)}`)
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
          monitorTitleAndNotify(
            input as unknown as { client: ClientLike },
            sessionID, savedTokens, notifyTimeout, log,
          ).catch((e) => log("notify: monitor error:", e))
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
