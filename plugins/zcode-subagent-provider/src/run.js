/**
 * One-shot ZCode CLI child lifecycle: spawn `zcode.cjs --prompt --json`
 * through the subprocess seam in the delegating session's workspace, collect
 * the final JSON report, and settle it into the shared subagent result
 * contract. ZCode configuration (provider, model, keys) remains native in
 * `~/.zcode/cli/config.json`.
 *
 * Settlement is report-driven, not exit-driven: the collected stdout is
 * polled for the final JSON report and the run settles the moment it parses —
 * the process tree is then terminated instead of awaited. This keeps the
 * terminal result independent of the runner's exit reporting and of zcode's
 * own teardown (plugin hosts, MCP children), which was observed to strand a
 * live runner beside an already-exited child, so `child.done` never resolved
 * and the run never settled. Failure and cancellation paths return the
 * collected stdout as partial output so a finished-but-unsettled answer is
 * not lost.
 *
 * @module dsh-plugin-subagent-zcode/run
 */

import { randomUUID } from 'node:crypto'
import { access, constants } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'

/** Default grace in milliseconds between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Headless execution mode that may execute tools (ZCode v0.16.5). */
export const DEFAULT_ZCODE_MODE = 'yolo'

/** How often the collected stdout is polled for the final report. */
export const SETTLE_POLL_MS = 500

/** Default overall run bound (`maxRunMs`): 30 minutes. */
export const DEFAULT_MAX_RUN_MS = 1_800_000

const PREFIX = 'subagent-zcode'
const MAX_STDOUT_BYTES = 1_048_576
const MAX_STDERR_BYTES = 16_384
const MAX_DIAGNOSTIC_STDERR_CHARS = 600
const MAX_RESPONSE_CHARS = 60_000

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
 * Verify the configured CLI entry exists before spawning, so a wrong
 * `entryPath` fails at the earliest resolvable point with a direct message.
 * @param {string} entryPath - configured absolute path of the ZCode CLI entry.
 * @returns {Promise<void>} resolves when the entry is an existing file.
 * @throws {Error} when the entry is missing or unreadable.
 */
export async function assertEntryExists(entryPath) {
  try {
    await access(entryPath, constants.X_OK)
  } catch {
    throw new Error(`${PREFIX}: config entryPath is not an executable file: ${entryPath}`)
  }
}

/**
 * Parse the final ZCode JSON report out of collected stdout: the whole text
 * first, then the last `\n{` segment (ZCode may print progress lines before
 * the report). Non-string or blank `response` fields do not count, so partial
 * reports and unrelated progress JSON never settle the run early.
 * @param {string} stdoutText - full collected stdout.
 * @returns {{ response: string, sessionId: string | undefined } | undefined} the parsed report, or undefined without a valid one.
 */
function parseZcodeReport(stdoutText) {
  let parsed
  try {
    parsed = JSON.parse(stdoutText)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined || typeof parsed !== 'object') {
    const idx = stdoutText.lastIndexOf('\n{')
    if (idx >= 0) {
      try {
        parsed = JSON.parse(stdoutText.slice(idx + 1))
      } catch {
        parsed = undefined
      }
    }
  }
  if (parsed === undefined || typeof parsed !== 'object') return undefined
  if (typeof parsed.response !== 'string' || parsed.response.trim() === '') return undefined
  return {
    response: parsed.response,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
  }
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
  const fields = ['product: ZCode', `stage: ${stage}`, `category: ${category}`]
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
 * Clip the report text to the parent-context budget (head kept).
 * @param {string} text - the full report response text.
 * @returns {string} the clipped text.
 */
function clipResponse(text) {
  return text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) : text
}

/**
 * The completed result for a parsed report.
 * @param {{ response: string }} report - parsed final report.
 * @returns {import('@deepseek-ai/dsh-subagent').SubagentResult} the completed result.
 */
function reportResult(report) {
  return { output: [{ type: 'text', text: clipResponse(report.response) }], stopReason: 'completed' }
}

/**
 * Select the subagent result from settled ZCode output. The report is the
 * terminal contract: when one has landed it wins even over a non-zero exit
 * (e.g. a teardown kill racing the final flush). Only a run without any
 * parseable report is failed, with the safe failure diagnostic.
 * @param {string} stdoutText - full collected stdout.
 * @param {string} stderrText - full collected stderr.
 * @param {{ exitCode: number | null, signal: string | null }} outcome - observed process outcome.
 * @param {(diagnostic: string) => void} record - diagnostic sink for a settled failure.
 * @returns {import('@deepseek-ai/dsh-subagent').SubagentResult} the completed result.
 * @throws {Error} when the run failed; the diagnostic is recorded first.
 */
function selectZcodeResult(stdoutText, stderrText, outcome, record) {
  /**
   * Build the thrown failure after recording its diagnostic.
   * @type {(stage: string, category: string, message: string) => Error}
   */
  const fail = (stage, category, message) => {
    record(failureDiagnostic(stage, category, outcome, stderrText))
    return new Error(`${PREFIX}: ${message}`)
  }
  const report = parseZcodeReport(stdoutText)
  if (report !== undefined) return reportResult(report)
  if (outcome.exitCode !== 0) {
    throw fail('process', 'process', `zcode exited without a report (exit code ${outcome.exitCode}${outcome.signal === null ? '' : `, signal ${outcome.signal}`})`)
  }
  throw fail('result', 'invalid-result', 'could not parse the zcode result JSON')
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
 * Fully resolved inputs for one ZCode CLI run.
 * @typedef {object} ZcodeRunSpec
 * @property {string} cwd - child workspace: the parent session cwd or the validated override.
 * @property {string} entryPath - validated absolute path of the ZCode CLI entry script.
 * @property {string} mode - headless execution mode passed as `--mode`.
 * @property {Record<string, string>} env - explicit environment entries layered after the shared subprocess scrub.
 * @property {number} disposeGraceMs - subprocess termination grace passed to the shared process-tree owner.
 * @property {number} maxRunMs - overall run bound; a run without a report for this long settles as an error.
 * @property {(spec: import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle} spawn - shared subprocess service spawn operation.
 * @property {((error: Error, stopReason: import('@deepseek-ai/dsh-subagent').SubagentStopReason) => void)} [onError] - diagnostic sink for a failure flattened to a stop reason.
 */

/**
 * Start one ZCode CLI child and publish its one-shot run. The run is
 * published after spawn; every later failure settles through the
 * never-rejecting result promise.
 * @param {import('@deepseek-ai/dsh-subagent').SubagentStartRequest} request - resolved shared subagent request.
 * @param {ZcodeRunSpec} spec - workspace, entry, mode, environment, and process service.
 * @returns {Promise<import('@deepseek-ai/dsh-subagent').SubagentRun>} the published run.
 */
export async function startZcodeRun(request, spec) {
  const task = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error(`${PREFIX}: request was aborted before zcode startup`)
  }
  await assertEntryExists(spec.entryPath)
  if (request.signal.aborted) {
    throw new Error(`${PREFIX}: request was aborted while validating the zcode entry`)
  }

  const argv = [
    process.execPath,
    spec.entryPath,
    '--prompt', task,
    '--json',
    '--mode', spec.mode,
    '--cwd', spec.cwd,
  ]

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
    throw new Error(`${PREFIX}: zcode spawn failed: ${message}`)
  }

  const spawned = child
  /** @type {string | undefined} */
  let diagnostic

  /**
   * Drive the run to its terminal result without trusting exit reporting:
   * poll the collected stdout for the final report and settle the moment it
   * parses (terminating the tree instead of awaiting it); otherwise race the
   * child's own exit; never run past `maxRunMs`. Never rejects — a run
   * without a report throws inside `selectZcodeResult`, which the wrapper
   * flattens with the recorded diagnostic.
   * @returns {Promise<import('@deepseek-ai/dsh-subagent').SubagentResult>} the terminal result.
   */
  const attempt = async () => {
    const deadline = Date.now() + spec.maxRunMs
    /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessOutcome} */
    let outcome = { exitCode: null, signal: null }
    let exited = false
    for (;;) {
      if (runAbort.signal.aborted) break
      const liveReport = parseZcodeReport(readCollected(spawned, 'stdout'))
      if (liveReport !== undefined) {
        // The answer is in hand; from the parent's perspective the child is
        // done. Release the tree — a wedged runner must not hold the result.
        spawned.terminate()
        return reportResult(liveReport)
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
      throw new Error(`${PREFIX}: zcode produced no report within maxRunMs (${spec.maxRunMs}ms)`)
    }
    return selectZcodeResult(readCollected(spawned, 'stdout'), readCollected(spawned, 'stderr'), outcome, (text) => { diagnostic = text })
  }

  const result = settleRunResult({
    attempt,
    collectOutput: () => {
      const stdoutText = readCollected(spawned, 'stdout')
      const report = parseZcodeReport(stdoutText)
      const text = report === undefined
        ? stdoutText.slice(-MAX_RESPONSE_CHARS)
        : clipResponse(report.response)
      return text.trim() === '' ? [] : [{ type: 'text', text }]
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
