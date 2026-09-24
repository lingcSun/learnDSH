/**
 * One-shot Cursor CLI child lifecycle: resolve the launch command (unwrapping
 * the official Windows `.cmd` shim to its versioned node entry), spawn
 * `cursor-agent --print` through the subprocess seam in the resolved
 * workspace, and settle the final answer into the shared subagent result
 * contract.
 *
 * Settlement is report-driven, not exit-driven (JSON output format): the
 * collected stdout is polled for the final result document and the run
 * settles the moment it parses — the process tree is then terminated instead
 * of awaited. This keeps the terminal result independent of the runner's exit
 * reporting and of the child's own teardown, which was observed to strand a
 * live runner beside an already-exited child, so `child.done` never resolved
 * and the run never settled. The text output format carries no in-stream
 * completion marker, so it stays exit-driven under the same overall run
 * bound. Failure and cancellation paths return the collected stdout as
 * partial output so a finished-but-unsettled answer is not lost.
 *
 * @module dsh-plugin-subagent-cursor/run
 */

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'

/** Default grace in milliseconds between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/**
 * Non-interactive permission modes mapped to cursor-agent flags: `plan`/`ask`
 * run read-only, `default` sends no permission flag, `force` adds `--force`
 * (auto-approve tool calls unless explicitly denied).
 */
export const CURSOR_PERMISSION_MODES = ['plan', 'ask', 'default', 'force']

/** Safe default for unattended runs: no extra permission flags. */
export const DEFAULT_CURSOR_PERMISSION_MODE = 'default'

/** Machine-readable output formats accepted with `--print`. */
export const CURSOR_OUTPUT_FORMATS = ['json', 'text']

/** Default output format: one JSON result document on stdout. */
export const DEFAULT_CURSOR_OUTPUT_FORMAT = 'json'

/** How often the collected stdout is polled for the final result document. */
export const SETTLE_POLL_MS = 500

/** Default overall run bound (`maxRunMs`): 30 minutes. */
export const DEFAULT_MAX_RUN_MS = 1_800_000

const PREFIX = 'subagent-cursor'
const MAX_STDOUT_BYTES = 2_097_152
const MAX_STDERR_BYTES = 16_384
const MAX_DIAGNOSTIC_STDERR_CHARS = 600
const MAX_PARTIAL_OUTPUT_CHARS = 60_000
const MAX_DOCUMENT_SCAN_TRIES = 32

// Same shape as the official PowerShell shim accepts, including the newer
// timestamped form `YYYY.MM.DD-HH-MM-SS-<commit>`.
const VERSION_DIR_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-([a-f0-9]+)$/

/**
 * Rank one installed cursor-agent version directory; higher sorts newer. The
 * date part dominates, then the presence of a build timestamp, then the name.
 * @param {string} name - directory name matching {@link VERSION_DIR_PATTERN}.
 * @returns {number} monotonic rank.
 */
function versionRank(name) {
  const [datePart, ...rest] = name.split('-')
  const stamped = rest.length > 1
  const commit = rest.at(-1) ?? ''
  return Date.parse(datePart) + (stamped ? 0.5 : 0) + Number.parseInt(commit.slice(0, 2), 16) / 256
}

/**
 * Resolve the process argv head for cursor-agent. A bare name or absolute
 * executable path is used directly; on Windows the official shim is a
 * `.cmd`/`.bat` that Node cannot spawn without a shell, so the same target
 * the shim runs — `<install>\versions\<latest>\node.exe <latest>\index.js` —
 * is resolved instead, keeping the child a plain node process the seam can
 * tree-kill.
 * @param {string} command - configured command (bare PATH name or absolute path).
 * @param {(command: string) => Promise<string>} resolveExecutable - shared subprocess executable resolution.
 * @returns {Promise<string[]>} the leading argv entries for the spawn.
 */
export async function resolveCursorArgvHead(command, resolveExecutable) {
  const resolved = await resolveExecutable(command)
  const lower = resolved.toLowerCase()
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return [resolved]

  const versionsDir = join(dirname(resolved), 'versions')
  // A missing or unreadable versions directory lands in the same loud
  // guidance below; no other recovery is possible from here.
  const names = await readdir(versionsDir).catch(() => [])
  const newest = names
    .filter(name => VERSION_DIR_PATTERN.test(name))
    .sort((a, b) => versionRank(a) - versionRank(b))
    .at(-1)
  const nodeExe = newest === undefined ? undefined : join(versionsDir, newest, 'node.exe')
  const indexJs = newest === undefined ? undefined : join(versionsDir, newest, 'index.js')
  if (newest === undefined || nodeExe === undefined || indexJs === undefined) {
    throw new Error(
      `${PREFIX}: ${resolved} carries no versions\\<version>\\{node.exe,index.js} payload — `
      + `set config command to a directly spawnable cursor-agent executable`,
    )
  }
  return [nodeExe, indexJs]
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} prompt - task content accepted from the shared subagent service.
 * @returns {string} the non-empty text task, block texts joined by a blank line.
 */
export function textTask(prompt) {
  if (prompt.length === 0) {
    throw new Error(`${PREFIX}: the one-shot task must contain only text blocks`)
  }
  const texts = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error(`${PREFIX}: the one-shot task must contain only text blocks`)
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error(`${PREFIX}: the one-shot task must not be empty`)
  }
  return texts.join('\n\n')
}

/**
 * Compose the full cursor-agent argv for one run. The task is the trailing
 * positional argument; every other input is a flag.
 * @param {object} parts - resolved run inputs.
 * @param {string[]} parts.argvHead - leading spawn entries from {@link resolveCursorArgvHead}.
 * @param {'json' | 'text'} parts.outputFormat - configured machine-readable output format.
 * @param {(typeof CURSOR_PERMISSION_MODES)[number]} parts.permissionMode - configured non-interactive permission mode.
 * @param {string | undefined} parts.model - optional configured model.
 * @param {readonly string[]} parts.extraArgs - extra CLI flags from configuration.
 * @param {string} parts.task - validated non-empty task text.
 * @returns {string[]} the complete spawn argv.
 */
export function cursorArgv({ argvHead, outputFormat, permissionMode, model, extraArgs, task }) {
  switch (permissionMode) {
    case 'plan':
    case 'ask':
    case 'default':
    case 'force':
      break
    default:
      throw new Error(`${PREFIX}: unknown permission mode ${JSON.stringify(permissionMode)}`)
  }
  return [
    ...argvHead,
    '--print',
    '--output-format', outputFormat,
    ...permissionMode === 'plan' ? ['--mode', 'plan'] : [],
    ...permissionMode === 'ask' ? ['--mode', 'ask'] : [],
    ...permissionMode === 'force' ? ['--force'] : [],
    ...model === undefined ? [] : ['--model', model],
    ...extraArgs,
    task,
  ]
}

/**
 * Extract the final result document from collected stdout: the whole text
 * first, then line-start `{` suffixes scanned from the end (progress
 * narration may precede the document). Only an object with
 * `type === 'result'` counts, so progress lines and partial documents never
 * settle the run early.
 * @param {string} stdoutText - full collected stdout.
 * @returns {Record<string, unknown> | undefined} the parsed result document, or undefined without a valid one.
 */
function parseCursorResultDocument(stdoutText) {
  let parsed
  try {
    parsed = JSON.parse(stdoutText)
  } catch {
    parsed = undefined
  }
  if (parsed !== undefined && typeof parsed === 'object' && parsed.type === 'result') {
    return parsed
  }
  let idx = stdoutText.length
  for (let tries = 0; tries < MAX_DOCUMENT_SCAN_TRIES; tries += 1) {
    idx = stdoutText.lastIndexOf('\n{', idx - 1)
    if (idx < 0) return undefined
    try {
      parsed = JSON.parse(stdoutText.slice(idx + 1))
    } catch {
      continue
    }
    if (parsed !== undefined && typeof parsed === 'object' && parsed.type === 'result') {
      return parsed
    }
  }
  return undefined
}

/**
 * Compose the safe failure diagnostic: coarse facts plus a bounded stderr
 * tail. Protocol payloads, environment values, and file contents stay out.
 * @param {string} stage - lifecycle stage the failure surfaced at.
 * @param {string} category - coarse failure category.
 * @param {{ exitCode: number | null, signal: string | null }} outcome - observed process outcome.
 * @param {string} stderrText - collected child stderr.
 * @returns {string} the diagnostic text.
 */
function failureDiagnostic(stage, category, outcome, stderrText) {
  const fields = ['product: Cursor', `stage: ${stage}`, `category: ${category}`]
  if (outcome.exitCode !== null) fields.push(`exit code: ${outcome.exitCode}`)
  if (outcome.signal !== null) fields.push(`signal: ${outcome.signal}`)
  let diagnostic = `Product subagent failure (${fields.join('; ')})`
  const tail = stderrText.trim()
  if (tail !== '') {
    diagnostic += `\nstderr tail: ${tail.length > MAX_DIAGNOSTIC_STDERR_CHARS ? `...${tail.slice(-MAX_DIAGNOSTIC_STDERR_CHARS)}` : tail}`
  }
  return diagnostic
}

/**
 * Read one collected stdio stream to its end; the pipes are drained because
 * the process tree has already exited.
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} child - settled subprocess handle.
 * @param {'stdout' | 'stderr'} stream - the stream to read.
 * @returns {string} the collected text, or '' when the stream is unavailable.
 */
function readCollected(child, stream) {
  try {
    return child.collected[stream]?.readFrom(0).text ?? ''
  } catch {
    // A failed diagnostic stream read must not mask the terminal outcome.
    return ''
  }
}

/**
 * Select the subagent result from the settled cursor-agent output. The result
 * document (JSON format) or the answer text (text format) is the terminal
 * contract: when one has landed it wins even over a non-zero exit (e.g. a
 * teardown kill racing the final flush). Only a run without any parseable
 * result is failed, with the safe failure diagnostic.
 * @param {'json' | 'text'} outputFormat - configured output format.
 * @param {string} stdoutText - full collected stdout.
 * @param {string} stderrText - full collected stderr.
 * @param {{ exitCode: number | null, signal: string | null }} outcome - observed process outcome.
 * @param {(diagnostic: string) => void} record - diagnostic sink for the settled failure.
 * @returns {import('@deepseek-ai/dsh-subagent').SubagentResult} the completed result.
 * @throws {Error} when the run failed; the diagnostic is recorded first.
 */
function selectCursorResult(outputFormat, stdoutText, stderrText, outcome, record) {
  /**
   * Build the thrown failure after recording its diagnostic.
   * @type {(stage: string, category: string, message: string) => Error}
   */
  const fail = (stage, category, message) => {
    record(failureDiagnostic(stage, category, outcome, stderrText))
    return new Error(`${PREFIX}: ${message}`)
  }
  if (outputFormat === 'text') {
    const text = stdoutText.trim()
    if (text === '') throw fail('result', 'invalid-result', 'cursor-agent produced no output in text format')
    return { output: [{ type: 'text', text }], stopReason: 'completed' }
  }
  const document = parseCursorResultDocument(stdoutText)
  if (document === undefined) {
    if (outcome.exitCode !== 0) {
      throw fail('process', 'process', `cursor-agent exited without a result (exit code ${outcome.exitCode}${outcome.signal === null ? '' : `, signal ${outcome.signal}`})`)
    }
    throw fail('result', 'invalid-result', 'could not parse the cursor-agent result JSON')
  }
  if (document.is_error === true) {
    throw fail('result', 'product-error', `cursor-agent reported an error result (${String(document.subtype ?? 'unknown')})`)
  }
  if (typeof document.result !== 'string') {
    throw fail('result', 'invalid-result', 'cursor-agent result document carries no answer text')
  }
  return { output: [{ type: 'text', text: document.result }], stopReason: 'completed' }
}

/**
 * Resolves after `ms`; used only as a polling tick, never awaited alone.
 * @param {number} ms - the tick duration in milliseconds.
 * @returns {Promise<void>} resolves when the tick elapses.
 */
function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Fully resolved inputs for one cursor-agent run.
 * @typedef {object} CursorRunSpec
 * @property {string} cwd - child workspace: the parent session cwd or the validated override.
 * @property {string} command - configured command (bare PATH name or absolute path).
 * @property {'json' | 'text'} outputFormat - configured machine-readable output format.
 * @property {(typeof CURSOR_PERMISSION_MODES)[number]} permissionMode - configured non-interactive permission mode.
 * @property {string | undefined} [model] - optional configured model passed as `--model`.
 * @property {readonly string[]} extraArgs - extra CLI flags from configuration, passed through verbatim.
 * @property {Record<string, string>} env - explicit environment entries layered after the shared subprocess scrub.
 * @property {number} disposeGraceMs - subprocess termination grace passed to the shared process-tree owner.
 * @property {number} maxRunMs - overall run bound; a run without a result for this long settles as an error.
 * @property {(command: string) => Promise<string>} resolveExecutable - shared subprocess executable resolution.
 * @property {(spec: import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle} spawn - shared subprocess service spawn operation.
 * @property {((error: Error, stopReason: import('@deepseek-ai/dsh-subagent').SubagentStopReason) => void)} [onError] - diagnostic sink for a failure flattened to a stop reason.
 */

/**
 * Start one `cursor-agent --print` child and publish its one-shot run. The
 * run is published after spawn; every later failure settles through the
 * never-rejecting result promise.
 * @param {import('@deepseek-ai/dsh-subagent').SubagentStartRequest} request - resolved shared subagent request.
 * @param {CursorRunSpec} spec - workspace, command, flags, environment, and process service.
 * @returns {Promise<import('@deepseek-ai/dsh-subagent').SubagentRun>} the published run.
 */
export async function startCursorRun(request, spec) {
  const task = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error(`${PREFIX}: request was aborted before cursor-agent startup`)
  }
  const argvHead = await resolveCursorArgvHead(spec.command, spec.resolveExecutable)
  if (request.signal.aborted) {
    throw new Error(`${PREFIX}: request was aborted while resolving the cursor-agent command`)
  }
  const argv = cursorArgv({
    argvHead,
    outputFormat: spec.outputFormat,
    permissionMode: spec.permissionMode,
    model: spec.model,
    extraArgs: spec.extraArgs,
    task,
  })

  const runAbort = new AbortController()
  /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessHandle | undefined} */
  let child
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error(`${PREFIX}: run cancelled locally`))
    // The spawn signal already tree-kills; terminate() covers a racing cancel
    // between spawn return and listener registration.
    child?.terminate()
  }
  const onAbort = () => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    child = spec.spawn({
      argv,
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
      signal: runAbort.signal,
    })
  } catch (error) {
    request.signal.removeEventListener('abort', onAbort)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${PREFIX}: cursor-agent spawn failed: ${message}`)
  }

  const spawned = child
  /** @type {string | undefined} */
  let diagnostic

  /**
   * Drive the run to its terminal result without trusting exit reporting:
   * poll the collected stdout for the final result document (JSON format) and
   * settle the moment it parses (terminating the tree instead of awaiting
   * it); otherwise race the child's own exit; never run past `maxRunMs`.
   * Never rejects — a run without a result throws inside
   * `selectCursorResult`, which the wrapper flattens with the recorded
   * diagnostic.
   * @returns {Promise<import('@deepseek-ai/dsh-subagent').SubagentResult>} the terminal result.
   */
  const attempt = async () => {
    const deadline = Date.now() + spec.maxRunMs
    /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessOutcome} */
    let outcome = { exitCode: null, signal: null }
    let exited = false
    for (;;) {
      if (runAbort.signal.aborted) break
      if (spec.outputFormat === 'json') {
        const liveDocument = parseCursorResultDocument(readCollected(spawned, 'stdout'))
        if (liveDocument !== undefined) {
          // The answer is in hand; from the parent's perspective the child is
          // done. Release the tree — a wedged runner must not hold the result.
          spawned.terminate()
          // Validation (error result / missing answer text) reuses the final
          // path so failures carry the same diagnostics.
          return selectCursorResult(spec.outputFormat, readCollected(spawned, 'stdout'), readCollected(spawned, 'stderr'), outcome, (text) => { diagnostic = text })
        }
      }
      if (exited || Date.now() >= deadline) break
      try {
        const winner = await Promise.race([spawned.done, delay(SETTLE_POLL_MS)])
        // `child.done` always resolves with an outcome object, so undefined
        // means only the poll tick fired.
        if (winner !== undefined) {
          outcome = winner
          exited = true
        }
      } catch (error) {
        exited = true
        spec.onError?.(error instanceof Error ? error : new Error(String(error)), 'error')
      }
    }
    if (!exited && !runAbort.signal.aborted) {
      diagnostic = failureDiagnostic('result', 'timeout', outcome, readCollected(spawned, 'stderr'))
      throw new Error(`${PREFIX}: cursor-agent produced no result within maxRunMs (${spec.maxRunMs}ms)`)
    }
    return selectCursorResult(spec.outputFormat, readCollected(spawned, 'stdout'), readCollected(spawned, 'stderr'), outcome, (text) => { diagnostic = text })
  }

  const result = settleRunResult({
    attempt,
    collectOutput: () => {
      const stdoutText = readCollected(spawned, 'stdout')
      if (spec.outputFormat === 'json') {
        const document = parseCursorResultDocument(stdoutText)
        if (document !== undefined && typeof document.result === 'string' && document.result.trim() !== '') {
          return [{ type: 'text', text: document.result }]
        }
      } else {
        const text = stdoutText.trim()
        if (text !== '') return [{ type: 'text', text }]
      }
      const tail = stdoutText.slice(-MAX_PARTIAL_OUTPUT_CHARS)
      return tail.trim() === '' ? [] : [{ type: 'text', text: tail }]
    },
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  const teardown = async () => {
    spawned.terminate()
    try {
      // Bounded: a wedged runner may never report tree quiescence, and the
      // disposal path must not hang behind it.
      await Promise.race([spawned.waitForExit(), delay(spec.disposeGraceMs)])
    } catch {
      // The terminal outcome is already owned by the polling settlement.
    }
  }
  return subprocessRunHandle({
    id: brandString(/** @type {import('@deepseek-ai/dsh-session').SessionId} */ (randomUUID())),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown,
  })
}
