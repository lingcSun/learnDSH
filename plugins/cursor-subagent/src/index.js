/**
 * Profile-named one-shot Cursor CLI subagent provider. Every accepted run
 * spawns a fresh `cursor-agent --print` process in the delegating session's
 * workspace through the subprocess seam and settles the final answer — or a
 * separate safe failure diagnostic — into the shared subagent result
 * contract. Cursor configuration and authentication remain native; the
 * provider fixes only the command, optional model, output format, permission
 * flags, and child environment.
 *
 * @module dsh-plugin-subagent-cursor
 */

import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  validateConfiguredCwd,
} from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import {
  CURSOR_OUTPUT_FORMATS,
  CURSOR_PERMISSION_MODES,
  DEFAULT_CURSOR_OUTPUT_FORMAT,
  DEFAULT_CURSOR_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_RUN_MS,
  startCursorRun,
} from './run.js'

export const name = 'subagent-cursor'
export const inject = ['subagents', 'subprocess']

const PREFIX = 'subagent-cursor'
const DEFAULT_PROVIDER_NAME = 'cursor'
const DEFAULT_COMMAND = 'cursor-agent'

/**
 * Deployment-owned command, model, permission, environment, and process-release settings.
 * @typedef {object} Config
 * @property {string} [providerName] Provider name on `ctx.subagents` (default `cursor`); each mounted instance needs a unique value.
 * @property {string} [command] cursor-agent command: a bare PATH name or an absolute executable path (default `cursor-agent`). The official Windows `.cmd` shim is unwrapped to its versioned node entry automatically.
 * @property {string} [model] Model fixed for every run from this instance (e.g. `composer-1`); omission inherits the native Cursor model selection.
 * @property {('json' | 'text')} [outputFormat] Result transport: `json` selects the documented result document, `text` takes the whole stdout as the answer (default `json`).
 * @property {(typeof CURSOR_PERMISSION_MODES)[number]} [permissionMode] Non-interactive permission mode: `plan`/`ask` read-only via `--mode`, `default` sends no flag, `force` adds `--force` auto-approval (default `default`).
 * @property {string[]} [extraArgs] Extra cursor-agent flags passed through verbatim (e.g. `["--trust", "--sandbox", "disabled"]`).
 * @property {Record<string, string>} [env] Explicit environment entries layered over the subprocess seam's credential-scrubbed parent environment; a `CURSOR_API_KEY` for headless auth belongs here.
 * @property {string} [cwd] Absolute child workspace override; omission delegates in the parent session's workspace.
 * @property {number} [disposeGraceMs] Grace in milliseconds for process-tree termination (default 3000).
 * @property {number} [maxRunMs] Overall run bound in milliseconds: a run with no parsed result this long after spawn settles as an error with partial output (default 1800000, i.e. 30 minutes).
 */

/** Plugin configuration schema; defaults are applied by the loader. */
export const Config = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  command: z.string().min(1).default(DEFAULT_COMMAND),
  model: z.string().min(1),
  outputFormat: z.union([...CURSOR_OUTPUT_FORMATS]).default(DEFAULT_CURSOR_OUTPUT_FORMAT),
  permissionMode: z.union([...CURSOR_PERMISSION_MODES]).default(DEFAULT_CURSOR_PERMISSION_MODE),
  extraArgs: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  cwd: z.string().min(1),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxRunMs: z.number().default(DEFAULT_MAX_RUN_MS),
})

/**
 * One Cursor CLI provider instance: a named, statically configured transport
 * for one-shot delegations into a genuine Cursor agent session.
 */
class CursorProvider {
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  /**
   * @param {string} name - registry name on `ctx.subagents`.
   * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying shared subagent and subprocess services.
   * @param {{ providerName: string, command: string, outputFormat: 'json' | 'text', permissionMode: (typeof CURSOR_PERMISSION_MODES)[number], extraArgs: string[], env: Record<string, string>, disposeGraceMs: number, maxRunMs: number, model?: string, cwd?: string }} config - resolved load-validated settings.
   */
  constructor(name, ctx, config) {
    this.name = name
    this.ctx = ctx
    this.config = config
  }

  /**
   * Start one cursor-agent child in the resolved workspace.
   * @param {import('@deepseek-ai/dsh-subagent').ResolvedSubagentStartRequest} request - validated start request with the delegating parent.
   * @returns {Promise<import('@deepseek-ai/dsh-subagent').SubagentRun>} the published one-shot run.
   */
  async start(request) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        `${PREFIX}: no working directory for the child — delegate from a parent session that has one `
        + `or configure \`cwd\``,
      )
    }
    let cwd
    try {
      cwd = resolveChildCwd(PREFIX, this.config.cwd, parentCwd)
    } catch (error) {
      if (request.signal.aborted) {
        throw new Error(`${PREFIX}: request was aborted before cursor-agent startup`)
      }
      throw error
    }
    return startCursorRun(request, {
      cwd,
      command: this.config.command,
      outputFormat: this.config.outputFormat,
      permissionMode: this.config.permissionMode,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      extraArgs: this.config.extraArgs,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      maxRunMs: this.config.maxRunMs,
      resolveExecutable: command => this.ctx.subprocess.resolveExecutable(command),
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`${PREFIX} "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    })
  }
}

/**
 * Register one Profile-named Cursor CLI provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying shared subagent and subprocess services.
 * @param {Config} options - registry name, command, model, output format, permission mode, child environment, run bound, and disposal grace.
 */
export function apply(ctx, options) {
  const cwd = validateConfiguredCwd(PREFIX, options.cwd)
  const resolved = {
    providerName: options.providerName ?? DEFAULT_PROVIDER_NAME,
    command: options.command ?? DEFAULT_COMMAND,
    outputFormat: options.outputFormat ?? DEFAULT_CURSOR_OUTPUT_FORMAT,
    permissionMode: options.permissionMode ?? DEFAULT_CURSOR_PERMISSION_MODE,
    extraArgs: options.extraArgs ?? [],
    env: options.env ?? {},
    disposeGraceMs: options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    maxRunMs: options.maxRunMs ?? DEFAULT_MAX_RUN_MS,
    ...options.model === undefined ? {} : { model: options.model },
    ...cwd === undefined ? {} : { cwd },
  }
  assertPositiveFinite(PREFIX, 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${PREFIX}: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveFinite(PREFIX, 'maxRunMs', resolved.maxRunMs)
  if (resolved.maxRunMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${PREFIX}: maxRunMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  ctx.subagents.registerProvider(new CursorProvider(resolved.providerName, ctx, resolved))
}
