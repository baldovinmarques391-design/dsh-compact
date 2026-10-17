/**
 * Integration test for the host half.
 *
 * Drives `apply()` against a fake Context and a fake preset-scoped compaction
 * engine, then asserts the gate's verdict — the thing unit tests on the pure
 * policy cannot prove (wrapping, ordering, fail-open behaviour).
 *
 * The decisive assertions are the two numbers at the end: a check at 899,999
 * tokens must not reach the engine, and a check at 900,000 must. Stock DSH would
 * have run compaction at 678,464, so a plugin that merely reproduced stock
 * behaviour would fail both.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const WINDOW = 1_000_000
const OUTPUT_RESERVE = 256_000

/**
 * Build a fake Context sufficient for `apply()`.
 *
 * @param options - measured pressure, routed output reservation, and engine hooks.
 * @returns the fake ctx plus the objects the test needs to inspect.
 */
function makeCtx(options = {}) {
  const {
    totalTokens,
    reservedCompletionTokens = OUTPUT_RESERVE,
    contextWindow = WINDOW,
    ...config
  } = options
  const listeners = new Map()
  const calls = []

  const engine = {
    compactIfNeeded: async (agent, trigger) => {
      calls.push(trigger)
      return { ran: trigger }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    inject(_deps, cb) {
      // Provide a settings service whose installSection immediately seeds the
      // "live" view from the config, the way the real one does.
      cb({
        settings: {
          installSection(_ctx, _name, _schema, resolved, options) {
            options?.setSource?.(resolved)
          },
        },
      })
    },
    on(event, listener, options) {
      listeners.set(event, { listener, options })
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow }, defaultMaxTokens: reservedCompletionTokens }
      },
    },
    tokenMeter: {
      measure() {
        return { totalTokens }
      },
    },
    agentPresets: {
      serviceFor() {
        return engine
      },
    },
  }

  const agent = {
    session: {
      requestHeader() {
        return { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: reservedCompletionTokens } }
      },
    },
  }

  return { ctx, engine, agent, calls, listeners, config, contextWindow }
}

/**
 * Register the plugin against a fake ctx.
 *
 * @param config - plugin config, and optionally `totalTokens` to set the
 *   measured pressure for this scenario.
 * @returns the harness, with the engine wrapped.
 */
async function install(config, overrides = {}) {
  const { apply } = await import('../lib/index.js')
  // Default scenario: comfortably below a 90% trigger, so the gate suppresses
  // unless a test says otherwise.
  const merged = {
    totalTokens: 500_000,
    reservedCompletionTokens: OUTPUT_RESERVE,
    ...config,
    ...overrides,
  }
  const harness = makeCtx(merged)
  apply(harness.ctx, config)
  return harness
}

test('plugin exposes the settings namespace and inject list', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-compact')
  assert.deepEqual(mod.inject, ['agentPresets', 'tokenMeter', 'llm'])
  assert.ok(mod.Config, 'Config schema must load — the plugin is unusable without it')
  assert.equal(typeof mod.apply, 'function')
})

test('a check below the ratio never reaches the engine', async () => {
  const h = await install({ triggerRatio: 0.9, enabled: true, routes: '*' }, { totalTokens: 899_999 })
  // The wrapper installs on the pre-step listener.
  const step = h.listeners.get('agent/pre-step')
  assert.ok(step, 'the plugin must register an agent/pre-step listener')
  step.listener({ agent: h.agent, signal: undefined }, () => undefined)

  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.equal(result, null, 'below the ratio the check must be suppressed')
  assert.deepEqual(h.calls, [], 'the engine must not be invoked at all')
})

test('a check at the ratio is handed to the engine', async () => {
  const h = await install({ triggerRatio: 0.9, enabled: true, routes: '*' }, { totalTokens: 900_000 })
  h.listeners.get('agent/pre-step').listener({ agent: h.agent, signal: undefined }, () => undefined)

  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(result, { ran: 'pressure' })
  assert.deepEqual(h.calls, ['pressure'])
})

test('stock DSH would have compacted at 678,464 — this plugin must not', async () => {
  const belowRatio = await install({ triggerRatio: 0.9 }, { totalTokens: 678_464 })
  belowRatio.listeners.get('agent/pre-step').listener({ agent: belowRatio.agent, signal: undefined }, () => undefined)
  const suppressed = await belowRatio.engine.compactIfNeeded(belowRatio.agent, 'pressure', undefined)
  assert.equal(suppressed, null, '678,464 tokens is far below a 90% trigger and must stay suppressed')

  const atRatio = await install({ triggerRatio: 0.9 }, { totalTokens: 900_000 })
  atRatio.listeners.get('agent/pre-step').listener({ agent: atRatio.agent, signal: undefined }, () => undefined)
  const ran = await atRatio.engine.compactIfNeeded(atRatio.agent, 'pressure', undefined)
  assert.deepEqual(ran, { ran: 'pressure' }, '900,000 tokens reaches the 90% trigger')
}, { concurrency: false })

test('overflow recovery and manual calls are never gated', async () => {
  const h = await install({ triggerRatio: 0.9 })
  h.listeners.get('agent/pre-step').listener({ agent: h.agent, signal: undefined }, () => undefined)

  assert.deepEqual(await h.engine.compactIfNeeded(h.agent, 'context-overflow', undefined), { ran: 'context-overflow' })
  assert.deepEqual(h.calls, ['context-overflow'], 'overflow must pass straight through')
})

test('disabling the plugin restores stock behaviour', async () => {
  const h = await install({ enabled: false, triggerRatio: 0.9 })
  h.listeners.get('agent/pre-step').listener({ agent: h.agent, signal: undefined }, () => undefined)
  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(result, { ran: 'pressure' })
})

test('a dry run observes without compacting', async () => {
  const h = await install({ triggerRatio: 0.9, dryRun: true }, { totalTokens: 950_000 })
  h.listeners.get('agent/pre-step').listener({ agent: h.agent, signal: undefined }, () => undefined)
  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.equal(result, null, 'a dry run must not compact the session')
  assert.deepEqual(h.calls, [], 'a dry run must not reach the engine')
})

test('fail-open: a broken measurement never blocks compaction', async () => {
  const { apply } = await import('../lib/index.js')
  const h = makeCtx({})
  h.ctx.tokenMeter.measure = () => { throw new Error('meter exploded') }
  apply(h.ctx, { triggerRatio: 0.9 })
  h.listeners.get('agent/pre-step').listener({ agent: h.agent, signal: undefined }, () => undefined)

  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(result, { ran: 'pressure' }, 'a thrown gate check must delegate, not suppress')
})

test('fail-open: an unresolvable model never blocks compaction', async () => {
  const { apply } = await import('../lib/index.js')
  const h = makeCtx({})
  h.ctx.llm.resolveModelInfo = async () => undefined
  apply(h.ctx, { triggerRatio: 0.9 })
  h.listeners.get('agent/pre-step').listener({ agent: h.agent, signal: undefined }, () => undefined)

  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(result, { ran: 'pressure' }, 'no capacity means delegate')
})

test('the wrapper is installed once per engine', async () => {
  const h = await install({ triggerRatio: 0.9 }, { totalTokens: 900_000 })
  const step = h.listeners.get('agent/pre-step')
  // Three steps in a row must not stack three wrappers.
  step.listener({ agent: h.agent, signal: undefined }, () => undefined)
  step.listener({ agent: h.agent, signal: undefined }, () => undefined)
  step.listener({ agent: h.agent, signal: undefined }, () => undefined)

  await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(h.calls, ['pressure'], 'one step must produce exactly one engine call, not a stack of them')
})
