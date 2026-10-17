/**
 * Pure trigger policy for dsh-compact.
 *
 * This file is deliberately free of Cordis/runtime imports so the decision math is
 * unit-testable in isolation. The host half (`lib/index.js`) is a thin adapter.
 *
 * ## Why this exists
 *
 * DSH 0.2 mounts its compaction backend (`@deepseek-ai/dsh-compaction-basic`)
 * inside each agent preset, where the effective policy is the shipped default
 * (`thresholdRatio: 0.8`, `headroomTokens: 65536`). That preset-plane row cannot
 * be reached by any patch layer, so the native trigger is fixed at
 *
 *     min(W * 0.8, W - O - 65536)
 *
 * With a 1,000,000-token window and a 256,000-token output reservation that is
 * 678,464 — 67.85% of the window, *not* the 80% the ratio suggests. The shipped
 * 65,536 constant is what actually binds on every window below 327,680 / 0.2,
 * and it keeps binding on a 1M window too, because the output reservation is
 * large enough that `W - O - 65536` stays the smaller term.
 *
 * This plugin does not repair that formula. It bypasses it: the trigger is
 *
 *     floor(ratio * W)
 *
 * and nothing else. There is no headroom subtraction, so a 0.9 ratio means the
 * conversation compacts at 90% of the window rather than at some number the
 * window size happened to push it to.
 *
 * ## What replaced the safety margin
 *
 * The native headroom exists so a generated answer cannot overflow the window.
 * A ratio already provides that margin for any window large enough to matter:
 * at ratio 0.9 on a 1M window, 100,000 tokens stay free for the answer. The
 * `minOutputReserve` option additionally refuses to *skip* a check when the
 * remaining room has fallen below a floor, so a request can never be gated open
 * with less than that much space left. Set it to the largest single response
 * you must not truncate; `0` disables the extra check and makes the ratio the
 * only rule.
 */

/** Schema defaults, mirrored here so the pure functions work without a runtime. */
export const POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  routes: '*',
  triggerRatio: 0.9,
  minOutputReserve: 0,
  dryRun: false,
  monitorPath: '',
  measureIntervalMs: 15000,
})

/** The ratio range the Config schema accepts. */
export const RATIO_MIN = 0.05
export const RATIO_MAX = 0.98

/**
 * Read a configuration value that may be a schemastery volatile cell.
 *
 * Volatile fields resolve to a lazy `{ get }` cell at some wire boundaries and
 * to plain values at others, so every read goes through this helper.
 *
 * @param value - plain value, volatile cell, or undefined.
 * @returns the underlying value.
 */
export function readValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** Treat undefined, null, and an emptied number input as "unset". */
function isUnsetNumber(value) {
  return value === undefined || value === null || value === ''
}

/**
 * Normalize raw plugin config or a resolved settings section into plain values.
 *
 * @param input - raw plugin config, resolved settings section, or undefined.
 * @returns plain `{ enabled, routes, triggerRatio, minOutputReserve, dryRun }`.
 */
export function normalizePolicy(input) {
  if (input === null || typeof input !== 'object') return { ...POLICY_DEFAULTS }

  const enabled = readValue(input.enabled)
  const routes = readValue(input.routes)
  const ratio = readValue(input.triggerRatio)
  const reserve = readValue(input.minOutputReserve)
  const dryRun = readValue(input.dryRun)
  const monitorPath = readValue(input.monitorPath)
  const measureInterval = readValue(input.measureIntervalMs)

  const ratioNumber = isUnsetNumber(ratio) ? POLICY_DEFAULTS.triggerRatio : Number(ratio)
  const reserveNumber = isUnsetNumber(reserve) ? POLICY_DEFAULTS.minOutputReserve : Number(reserve)
  const intervalNumber = isUnsetNumber(measureInterval) ? POLICY_DEFAULTS.measureIntervalMs : Number(measureInterval)

  return {
    enabled: enabled === undefined ? POLICY_DEFAULTS.enabled : enabled === true,
    routes: routes === undefined || routes === null ? POLICY_DEFAULTS.routes : String(routes),
    triggerRatio: Number.isFinite(ratioNumber) ? ratioNumber : POLICY_DEFAULTS.triggerRatio,
    minOutputReserve: Number.isFinite(reserveNumber) && reserveNumber > 0 ? Math.floor(reserveNumber) : 0,
    dryRun: dryRun === true,
    monitorPath:
      monitorPath === undefined || monitorPath === null || monitorPath === ''
        ? POLICY_DEFAULTS.monitorPath
        : String(monitorPath),
    // `0` means "measure every step" — the pre-throttle behaviour.
    measureIntervalMs:
      Number.isFinite(intervalNumber) && intervalNumber >= 0
        ? Math.floor(intervalNumber)
        : POLICY_DEFAULTS.measureIntervalMs,  }
}

/**
 * Parse the route filter text.
 *
 * Accepts `provider` or `provider/model` entries separated by commas,
 * semicolons, or whitespace. `*` matches everything, a bare provider matches
 * every model under it, and `provider/*` is the same thing spelled out.
 *
 * @param text - raw configuration value.
 * @returns parsed entries in declaration order.
 */
export function parseRouteList(text) {
  return String(text ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const slash = entry.indexOf('/')
      if (slash < 0) return { provider: entry, model: undefined }
      return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) || undefined }
    })
}

/**
 * Whether a routed target is covered by the parsed filter.
 *
 * @param entries - result of {@link parseRouteList}.
 * @param target - `{ provider, model }` of the latest durable request.
 * @returns true when at least one entry covers the target.
 */
export function routeMatches(entries, target) {
  if (target === undefined || target.provider === undefined) return false
  return entries.some((entry) => {
    if (entry.provider === '*') return true
    if (entry.provider !== target.provider) return false
    return entry.model === undefined || entry.model === '*' || entry.model === target.model
  })
}

/**
 * The token count at which automatic compaction may run: `floor(ratio * W)`.
 *
 * Deliberately independent of the routed request's output reservation. The
 * reservation used to move the trigger; here it only participates in the
 * {@link computeRoomTokens} guard.
 *
 * @param options - `{ contextWindow, triggerRatio }`.
 * @returns the trigger in tokens, or undefined when no trigger can be computed.
 */
export function computeTriggerTokens(options) {
  const { contextWindow, triggerRatio = POLICY_DEFAULTS.triggerRatio } = options ?? {}
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  if (!Number.isFinite(triggerRatio) || triggerRatio <= 0 || triggerRatio > 1) return undefined
  return Math.floor(contextWindow * triggerRatio)
}

/**
 * Free room above the measured pressure: `W - O - measured`.
 *
 * @param options - `{ contextWindow, reservedCompletionTokens, totalTokens }`.
 * @returns remaining room in tokens, or undefined when it cannot be computed.
 */
export function computeRoomTokens(options) {
  const { contextWindow, reservedCompletionTokens = 0, totalTokens } = options ?? {}
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  if (!Number.isFinite(reservedCompletionTokens) || !Number.isFinite(totalTokens)) return undefined
  return contextWindow - reservedCompletionTokens - totalTokens
}

/**
 * Decide whether an automatic pressure check runs.
 *
 * Every uncertain path answers `delegate`, so this plugin can never make the
 * backend behave *better* than stock in a way that surprises a caller: it either
 * suppresses a check it can prove is too early, or it hands the check back to
 * DSH's own engine unchanged.
 *
 * @param options - live policy plus the routed capacity and measured pressure.
 * @returns `'skip'` to suppress this check, `'delegate'` to let the engine run.
 */
export function decide(options) {
  const { policy, target, contextWindow, reservedCompletionTokens = 0, totalTokens } = options ?? {}

  if (policy?.enabled !== true) return 'delegate'

  const routes = parseRouteList(policy.routes)
  if (routes.length === 0) return 'delegate'
  if (target !== undefined && !routeMatches(routes, target)) return 'delegate'

  const threshold = computeTriggerTokens({
    contextWindow,
    triggerRatio: policy.triggerRatio,
  })
  if (threshold === undefined) return 'delegate'
  if (!Number.isFinite(totalTokens)) return 'delegate'

  if (totalTokens >= threshold) return 'delegate'

  // Below the ratio, so the default answer is "too early". The minOutputReserve
  // guard is what can override that: when the room left for the answer has
  // fallen under the floor, compact *now* rather than risk a truncated reply.
  // This can only ever run compaction earlier than the ratio alone would, which
  // is the safe direction — it never delays a needed compaction.
  const reserve = policy.minOutputReserve ?? 0
  if (reserve > 0) {
    const room = computeRoomTokens({ contextWindow, reservedCompletionTokens, totalTokens })
    if (room !== undefined && room < reserve) return 'delegate'
  }

  return 'skip'
}

/**
 * Explain a decision for logging, without changing it.
 *
 * @param options - same options as {@link decide}, plus the decision taken.
 * @returns a one-line human-readable summary.
 */
export function describeDecision(options) {
  const { policy, contextWindow, reservedCompletionTokens = 0, totalTokens, decision } = options ?? {}
  const threshold = computeTriggerTokens({ contextWindow, triggerRatio: policy?.triggerRatio })
  const pct = Number.isInteger(contextWindow) && contextWindow > 0 && threshold !== undefined
    ? ((threshold / contextWindow) * 100).toFixed(2)
    : '?'
  const room = computeRoomTokens({ contextWindow, reservedCompletionTokens, totalTokens })
  return [
    `decision=${decision}`,
    `ratio=${policy?.triggerRatio}`,
    `window=${contextWindow}`,
    `threshold=${threshold} (${pct}%)`,
    `measured=${totalTokens}`,
    `room=${room}`,
  ].join(' ')
}
