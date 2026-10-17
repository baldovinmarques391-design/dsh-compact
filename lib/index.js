/**
 * dsh-compact — host half.
 *
 * ## The problem this solves
 *
 * DSH 0.2 mounts the compaction backend (`@deepseek-ai/dsh-compaction-basic`)
 * inside each agent preset. That preset-plane row carries the shipped defaults
 * (`thresholdRatio: 0.8`, `headroomTokens: 65536`) and no patch layer — neither
 * the profile's `cordis.patch.yml` nor a plugin's own bundle patch — can reach
 * it, because those layers only address the host plane.
 *
 * The resulting trigger is
 *
 *     min(W * 0.8, W - O - 65536)
 *
 * and on a 1,000,000-token window with the DeepSeek adapter's default 256,000-token
 * output reservation (`O`) that is 678,464 — 67.85% of the window. The 65,536
 * constant is meant as a safety margin but acts as a hard ceiling, so the ratio
 * the user configured is never the term that actually decides. Compaction starts
 * roughly a third of the window before the edge, which is exactly the complaint
 * this plugin exists to fix.
 *
 * ## What this plugin does instead
 *
 * It gates the *live* preset engine. `agentPresets.serviceFor(agent, 'compaction')`
 * resolves the engine mounted in that agent's preset scope; this plugin prepends
 * an `agent/pre-step` listener that suppresses the engine's automatic pressure
 * check until
 *
 *     floor(triggerRatio * W)
 *
 * is crossed. No fixed subtraction, so the ratio means what it says. The engine's
 * own request-error overflow recovery is never gated, so a provider-confirmed
 * context overflow still recovers exactly as stock.
 *
 * Nothing is patched, persisted, or pinned: removing the plugin restores stock
 * behaviour exactly.
 *
 * @module dsh-compact
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { computeTriggerTokens, decide, describeDecision, normalizePolicy, parseRouteList } from './policy.js'

/**
 * Default monitor path: `<DSH_HOME>/logs/dsh-compact-monitor.jsonl`, falling back
 * to the system temp directory when DSH_HOME is unset.
 *
 * The monitor is the only way to observe a suppressed check, so the plugin must
 * work with zero configuration — installing the bundle from the plugin page is
 * enough. A deployment that wants the file elsewhere sets `monitorPath`.
 */
const DEFAULT_MONITOR_PATH = (() => {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    try {
      return join(home, 'logs', 'dsh-compact-monitor.jsonl')
    } catch {
      /* fall through to the temp directory */
    }
  }
  return join(tmpdir(), 'dsh-compact-monitor.jsonl')
})()

/** Create the monitor's parent directory once, on first write. */
let monitorDirReady = false

/**
 * Append one decision line to the monitor.
 *
 * Never throws: monitoring is diagnostics, and a failed write must not change
 * whether a compaction check runs.
 *
 * @param path - monitor file path, or undefined to skip.
 * @param record - the decision and the numbers behind it.
 */
function monitor(path, record) {
  if (typeof path !== 'string' || path.length === 0) return
  try {
    if (!monitorDirReady) {
      monitorDirReady = true
      try {
        mkdirSync(dirname(path), { recursive: true })
      } catch {
        /* an existing directory or an unwritable parent; append will report it */
      }
    }
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    /* diagnostics only */
  }
}

/** Settings namespace == bundle row id, so the settings UI can join them. */
export const name = 'dsh-compact'

/** Services resolved before `apply` runs. */
export const inject = ['agentPresets', 'tokenMeter', 'llm']

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('是否启用本插件。关闭后完全按 DSH 原生策略压缩，不做任何干预。')
    .volatile(),
  routes: Schema.string()
    .default('*')
    .description('要生效的路由：provider 或 provider/model，用逗号或空格分隔；* 表示所有路由。例：deepseek-official/deepseek-flash')
    .volatile(),
  triggerRatio: Schema.number()
    .min(0.05)
    .max(0.98)
    .default(0.9)
    .description('窗口用到这个比例时压缩。0.9 = 90%。不设固定余量扣减，所以这个比例就是真正的触发点。')
    .volatile(),
  minOutputReserve: Schema.number()
    .step(1)
    .min(0)
    .default(0)
    .description('输出保护底线（token）：剩余空间低于此值时，即使没到比例也提前压缩，避免回答被截断。0 = 关闭，比例是唯一规则。')
    .volatile(),
  dryRun: Schema.boolean()
    .default(false)
    .description('只记录判定（阈值、实测、是否放行），不实际抑制压缩。用来在正式启用前验证触发点。')
    .volatile(),
  monitorPath: Schema.string()
    .default(DEFAULT_MONITOR_PATH)
    .description('判定监视器写入的 JSONL 文件路径（每行一条判定：阈值/实测/是否放行）。留空则不写。用于事后核对触发点，也是"压缩前没有任何提示"这个盲点的补丁。')
    .volatile(),
  measureIntervalMs: Schema.number()
    .step(1)
    .min(0)
    .default(15000)
    .description('整段测量的节流间隔（毫秒）。远离触发点时最多每这么久测一次；进入阈值 2% 范围内改为每步都测。0 = 每步都测（旧行为，长会话下开销大）。')
    .volatile(),
})

/**
 * Resolve the durable routed target of a session, mirroring how the backend
 * itself reads it.
 *
 * @param agent - the agent whose latest request envelope is inspected.
 * @returns `{ provider, model }`, or undefined before any routed request.
 */
function routedTarget(agent) {
  const config = agent?.session?.requestHeader?.()?.config
  if (config !== undefined && config !== null && config.provider && config.model) {
    return { provider: config.provider, model: config.model }
  }
  // Before the first routed request the session has no logged envelope at all —
  // `requestHeader()` yields `config: null`. The agent's own options are the
  // same either way, and they are what the engine falls back to for its
  // summarization target, so the gate can resolve capacity on step one instead
  // of standing down until a request has already gone out.
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
    return { provider, model }
  }
  return undefined
}

export function apply(ctx, config) {
  /** Live effective config: `installSection` keeps this in step with the user document. */
  const live = { value: normalizePolicy(config) }

  const effective = live.value
  monitor(effective.monitorPath, {
    kind: 'apply',
    triggerRatio: effective.triggerRatio,
    routes: effective.routes,
    monitorPath: effective.monitorPath,
  })
  ctx.logger?.info?.(
    `dsh-compact: active — ratio=${effective.triggerRatio}` +
      ` routes=${effective.routes}` +
      ` minOutputReserve=${effective.minOutputReserve}` +
      (effective.dryRun ? ' dryRun=true' : ''),
  )

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, name, Config, config, {
      applies: 'live',
      // Merge over the resolved config rather than replacing it. The settings
      // document only carries the keys the user actually edited there, so a
      // plain replacement would drop every value that came from the profile's
      // patch layer — `monitorPath` among them, which would silently disable
      // the monitor the moment the section installed.
      setSource: (current) => {
        live.value = normalizePolicy({ ...live.value, ...(current ?? {}) })
      },
      onChange: () => {},
    })
  })

  /** One wrapper per engine instance; a new preset generation yields a new instance. */
  const instrumented = new WeakSet()

  /**
   * Messages the current step is about to send, keyed by agent.
   *
   * `agent/pre-step` sees them; the engine's pressure entry point does not. The
   * wrapper reads and clears this so the gate can price the request that is
   * actually about to go out rather than only the committed history.
   */
  const pendingByAgent = new WeakMap()

  /**
   * Last priced surface per agent, so the O(surface) meter is not repeated on
   * every step while pressure is far below the trigger.
   */
  const lastMeasured = new WeakMap()

  /**
   * Route capacity cache. `resolveModelInfo` is a registry lookup whose answer
   * cannot change while the process runs, so one call per route is enough.
   */
  const modelInfoCache = new Map()

  /**
   * Resolve the routed model's capacity, caching per provider/model.
   *
   * @param target - routed provider/model.
   * @param signal - turn cancellation signal.
   * @returns the adapter's model info, or undefined when unavailable.
   */
  async function modelInfo(target, signal) {
    const key = `${target.provider}/${target.model}`
    const hit = modelInfoCache.get(key)
    if (hit !== undefined) return hit
    const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    if (info !== undefined && info !== null) modelInfoCache.set(key, info)
    return info
  }

  /**
   * Evaluate one automatic pressure check.
   *
   * Every failure path answers `false` (= do not suppress), so this plugin can
   * never make the backend compact *less* than stock.
   *
   * @param agent - agent being checked.
   * @param signal - turn cancellation signal.
   * @param pendingMessages - messages this step is about to send, not yet on the surface.
   * @returns true when the check is below our threshold and must be suppressed.
   */
  async function shouldSkip(agent, signal, pendingMessages) {
    const policy = live.value
    if (policy?.enabled !== true) {
      monitor(policy?.monitorPath, { kind: 'gate-skip', reason: 'disabled' })
      return false
    }

    const routes = parseRouteList(policy.routes)
    if (routes.length === 0) {
      monitor(policy.monitorPath, { kind: 'gate-skip', reason: 'no-routes', routes: policy.routes })
      return false
    }

    const target = routedTarget(agent)
    if (target === undefined) {
      const headerConfig = agent?.session?.requestHeader?.()?.config
      monitor(policy.monitorPath, {
        kind: 'gate-skip',
        reason: 'no-routed-target',
        hasSession: agent?.session !== undefined,
        headerConfig: headerConfig === undefined ? null : JSON.stringify(headerConfig).slice(0, 120),
        // Discovery record: which carrier actually holds the routed target on
        // this DSH build. Kept because guessing it wrong silently disables the gate.
        agentKeys: agent === undefined ? null : Object.keys(agent).slice(0, 40),
        agentOptions: agent?.options === undefined ? null : JSON.stringify(agent.options).slice(0, 200),
        sessionKeys: agent?.session === undefined ? null : Object.keys(agent.session).slice(0, 40),
        agentModel: agent?.model ?? null,
        agentProvider: agent?.provider ?? null,
      })
      return false
    }

    try {
      const header = agent?.session?.requestHeader?.()
      const info = await modelInfo(target, signal)
      const contextWindow = info?.context?.contextWindow
      const threshold = computeTriggerTokens({ contextWindow, triggerRatio: policy.triggerRatio })

      // `measure()` prices the entire surface on every call: it walks every node,
      // re-prices it, then structuredClones and deep-freezes the whole node list.
      // On a long session that is the most expensive thing this plugin does, and
      // repeating it every step buys nothing while pressure is far from the
      // trigger — pressure grows by hundreds of tokens per step, not by a
      // measurable fraction of the window.
      //
      // So: reuse the last priced surface while it is comfortably below the
      // trigger and recent enough, and measure every step near the trigger so the
      // crossing is never overshot.
      const now = Date.now()
      const last = lastMeasured.get(agent)
      const nearWindow = Number.isFinite(threshold) ? Math.max(8192, Math.floor(threshold * 0.02)) : 8192
      // Inside the near-window the gate must see every step, so the meter runs
      // even when the interval has not elapsed; outside it, staleness is safe
      // because pressure moves by hundreds of tokens per step.
      const nearEdge = last !== undefined && threshold !== undefined && last.surface >= threshold - nearWindow
      const canReuse =
        last !== undefined &&
        threshold !== undefined &&
        !nearEdge &&
        now - last.at < policy.measureIntervalMs

      let surfaceTokens
      if (canReuse) {
        surfaceTokens = last.surface
      } else {
        surfaceTokens = ctx.tokenMeter.measure(agent.session)?.totalTokens ?? 0
        lastMeasured.set(agent, { at: now, surface: surfaceTokens })
      }

      // `agent/pre-step` runs BEFORE the request is derived, so the message that
      // is about to be sent is not on the session surface yet and `measure()`
      // reports only the already-committed history. Setting the threshold against
      // that alone would leave the gate open on every first step (measured 0).
      // The step's own pending messages are priced here and added, so the verdict
      // describes the request that is actually about to go out.
      const pending = Array.isArray(pendingMessages) ? pendingMessages : []
      let pendingTokens = 0
      for (const message of pending) {
        try {
          pendingTokens += ctx.tokenMeter.estimateMessage(message) ?? 0
        } catch {
          /* a message that cannot be priced contributes nothing */
        }
      }
      const measuredTokens = surfaceTokens + pendingTokens

      const options = {
        policy,
        target,
        contextWindow: info?.context?.contextWindow,
        // The effective envelope's own cap wins; before the first request exists
        // that is absent, so fall back to the adapter's declared default — the
        // same value the adapter materializes when an envelope omits it.
        reservedCompletionTokens: header?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0,
        totalTokens: measuredTokens,
      }
      const decision = decide(options)

      // The monitor is the observable half of this plugin. A suppressed check
      // reaches no engine and writes no session event, so without a side channel
      // there is nothing to look at while the threshold is being approached —
      // which is exactly the blind spot that makes an early compaction feel like
      // silent memory loss. Every verdict is appended, one JSON line per check.
      monitor(policy.monitorPath, {
        decision,
        provider: target.provider,
        model: target.model,
        contextWindow: options.contextWindow,
        reservedCompletionTokens: options.reservedCompletionTokens,
        thresholdTokens: computeTriggerTokens({ contextWindow: options.contextWindow, triggerRatio: policy.triggerRatio }),
        // The engine's own trigger, computed with the shipped constants. When a
        // `skip` verdict has measuredTokens >= nativeThresholdTokens, this plugin
        // suppressed a check the engine would otherwise have acted on — which is
        // the whole claim, and it can be read off one log line without waiting
        // for a real compaction to occur.
        nativeThresholdTokens: (() => {
          const w = options.contextWindow
          if (!Number.isInteger(w) || w <= 0) return null
          const budget = w - (options.reservedCompletionTokens ?? 0) - 65_536
          return Math.floor(Math.min(w * 0.8, budget))
        })(),
        measuredTokens: options.totalTokens,
        surfaceTokens,
        surfaceReused: canReuse,
        pendingTokens,
        triggerRatio: policy.triggerRatio,
        dryRun: policy.dryRun,
        sessionId: agent?.session?.id,
      })

      if (policy.dryRun) {
        // A dry run is non-destructive by construction: it never lets the check
        // through, so the session is not compacted. Only the verdict is logged.
        // That makes it safe to leave on while watching the threshold land.
        ctx.logger?.info?.(`dsh-compact[dry-run]: ${describeDecision({ ...options, decision })}`)
        return true
      }

      if (decision === 'skip') {
        ctx.logger?.info?.(`dsh-compact: ${describeDecision({ ...options, decision })}`)
        return true
      }
      return false
    } catch (error) {
      // Fail open, but never silently: this branch means the gate could not
      // reach a verdict, so a compaction may run that this plugin would have
      // suppressed. Recording it is the difference between "working" and
      // "quietly doing nothing".
      monitor(live.value.monitorPath, {
        kind: 'gate-error',
        error: String(error?.message ?? error),
        stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | '),
      })
      ctx.logger?.warn?.(`dsh-compact: gate check failed, delegating (${String(error)})`)
      return false
    }
  }

  /**
   * Wrap the preset-scoped compaction engine's automatic pressure entry once.
   *
   * @param agent - agent whose preset scope is inspected.
   */
  function instrument(agent) {
    const trace = live.value.monitorPath
    if (live.value?.enabled !== true) {
      monitor(trace, { kind: 'instrument', outcome: 'plugin-disabled' })
      return
    }

    let engine
    try {
      engine = ctx.agentPresets?.serviceFor?.(agent, 'compaction')
    } catch (error) {
      monitor(trace, { kind: 'instrument', outcome: 'serviceFor-threw', error: String(error) })
      return
    }
    if (engine === undefined || engine === null) {
      monitor(trace, {
        kind: 'instrument',
        outcome: 'no-engine',
        hasAgentPresets: ctx.agentPresets !== undefined,
        hasAgentCtx: agent?.ctx !== undefined,
      })
      return
    }
    if (instrumented.has(engine)) return

    const original = engine.compactIfNeeded
    if (typeof original !== 'function') {
      monitor(trace, { kind: 'instrument', outcome: 'engine-has-no-compactIfNeeded' })
      return
    }
    instrumented.add(engine)

    engine.compactIfNeeded = async function compactIfNeeded(target, trigger, signal) {
      monitor(live.value.monitorPath, { kind: 'wrapper-called', trigger })
      // Overflow recovery and manual calls keep their native semantics; only the
      // automatic pressure check is gated here.
      if (trigger !== 'pressure') return original.call(this, target, trigger, signal)
      // The pending step messages were captured by the pre-step listener, which
      // is the only place they are visible. Consume once so a stale list can
      // never be priced against a later step.
      const pending = pendingByAgent.get(target) ?? []
      pendingByAgent.delete(target)
      if (await shouldSkip(target, signal, pending)) return null
      return original.call(this, target, trigger, signal)
    }

    monitor(trace, { kind: 'instrument', outcome: 'attached', triggerRatio: live.value.triggerRatio })
    ctx.logger?.info?.(
      `dsh-compact: attached to the preset-scoped compaction engine — automatic pressure checks now gate at ${live.value.triggerRatio * 100}%`,
    )
  }

  // `prepend` so the wrapper is installed before the engine's own listener runs
  // in the same step. The listener chain is the serial `agent/pre-step`
  // waterfall, and a listener that never awaits `next()` ends the chain — which
  // is why a suppressed check must not call it from here.
  ctx.on(
    'agent/pre-step',
    (payload, next) => {
      const agent = payload?.agent
      if (agent !== undefined) {
        const pending = Array.isArray(payload?.messages) ? payload.messages : []
        if (pending.length > 0) pendingByAgent.set(agent, pending)
      }
      try {
        instrument(agent)
      } catch (error) {
        monitor(live.value.monitorPath, { kind: 'instrument', outcome: 'threw', error: String(error) })
      }
      return next?.()
    },
    { prepend: true },
  )

  // Exposed for the acceptance test, which drives this wiring against a real
  // BasicCompactionEngine instead of a stand-in.
  return { shouldSkip, instrument, policy: live }
}
