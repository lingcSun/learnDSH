/**
 * Profile-named one-shot ZCode CLI subagent provider. Every accepted run
 * spawns a fresh `zcode.cjs --prompt --json` process in the delegating
 * session's workspace through the subprocess seam and settles the final
 * report — or a separate safe failure diagnostic — into the shared subagent
 * result contract. ZCode provider, model, and credentials remain native in
 * `~/.zcode/cli/config.json`; the provider fixes only the entry, headless
 * mode, child environment, and workspace.
 *
 * @module dsh-plugin-subagent-zcode
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
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_RUN_MS,
  DEFAULT_ZCODE_MODE,
  startZcodeRun,
} from './run.js'

export const name = 'subagent-zcode'
export const inject = ['subagents', 'subprocess']

const PREFIX = 'subagent-zcode'
const DEFAULT_PROVIDER_NAME = 'zcode'
const DEFAULT_ENTRY_PATH = 'D:\\ZCode\\resources\\glm\\zcode.cjs'

/**
 * Deployment-owned entry, mode, environment, and process-release settings.
 * @typedef {object} Config
 * @property {string} [providerName] Provider name on `ctx.subagents` (default `zcode`); each mounted instance needs a unique value.
 * @property {string} [entryPath] Absolute path of the ZCode CLI entry script (default this machine's `D:\ZCode\resources\glm\zcode.cjs`); validated at the first run.
 * @property {string} [mode] Headless execution mode passed as `--mode`; only `yolo` executes tools headless on ZCode v0.16.5 (default `yolo`).
 * @property {Record<string, string>} [env] Explicit environment entries layered over the subprocess seam's credential-scrubbed parent environment.
 * @property {string} [cwd] Absolute child workspace override; omission delegates in the parent session's workspace.
 * @property {number} [disposeGraceMs] Grace in milliseconds for process-tree termination (default 3000).
 * @property {number} [maxRunMs] Overall run bound in milliseconds: a run with no parsed report this long after spawn settles as an error with partial output (default 1800000, i.e. 30 minutes).
 */

/** Plugin configuration schema; defaults are applied by the loader. */
export const Config = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  entryPath: z.string().min(1).default(DEFAULT_ENTRY_PATH),
  mode: z.string().min(1).default(DEFAULT_ZCODE_MODE),
  env: z.dict(z.string()).default({}),
  cwd: z.string().min(1),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxRunMs: z.number().default(DEFAULT_MAX_RUN_MS),
})

/**
 * One ZCode CLI provider instance: a named, statically configured transport
 * for one-shot delegations into a genuine ZCode agent session.
 */
class ZcodeProvider {
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  /**
   * @param {string} name - registry name on `ctx.subagents`.
   * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying shared subagent and subprocess services.
   * @param {{ providerName: string, entryPath: string, mode: string, env: Record<string, string>, disposeGraceMs: number, maxRunMs: number, cwd?: string }} config - resolved load-validated settings.
   */
  constructor(name, ctx, config) {
    this.name = name
    this.ctx = ctx
    this.config = config
  }

  /**
   * Start one ZCode CLI child in the resolved workspace.
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
        throw new Error(`${PREFIX}: request was aborted before zcode startup`)
      }
      throw error
    }
  return startZcodeRun(request, {
    cwd,
    entryPath: this.config.entryPath,
    mode: this.config.mode,
    env: this.config.env,
    disposeGraceMs: this.config.disposeGraceMs,
    maxRunMs: this.config.maxRunMs,
    spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
    onError: (error, stopReason) => {
      this.ctx.logger.warn(`${PREFIX} "${this.name}": child run failed (${stopReason}): ${error.message}`)
    },
  })
  }
}

/**
 * Register one Profile-named ZCode CLI provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying shared subagent and subprocess services.
 * @param {Config} options - registry name, entry path, headless mode, child environment, run bound, and disposal grace.
 */
export function apply(ctx, options) {
  const cwd = validateConfiguredCwd(PREFIX, options.cwd)
  const resolved = {
    providerName: options.providerName ?? DEFAULT_PROVIDER_NAME,
    entryPath: options.entryPath ?? DEFAULT_ENTRY_PATH,
    mode: options.mode ?? DEFAULT_ZCODE_MODE,
    env: options.env ?? {},
    disposeGraceMs: options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    maxRunMs: options.maxRunMs ?? DEFAULT_MAX_RUN_MS,
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
  ctx.subagents.registerProvider(new ZcodeProvider(resolved.providerName, ctx, resolved))
}
