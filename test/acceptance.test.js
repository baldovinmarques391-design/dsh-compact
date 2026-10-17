/**
 * Acceptance test: drive the plugin's wiring end to end, with the monitor on.
 *
 * `BasicCompactionEngine` cannot be constructed outside a real Cordis Context
 * (`new Service` requires it), so the engine here is a faithful stand-in: it
 * exposes `compactIfNeeded(agent, trigger, signal)` exactly as the shipped one
 * does and lets the test observe whether it was entered. What these tests pin
 * down is the wiring itself — that the wrapper is installed, reached, idempotent,
 * and that every verdict lands in the monitor file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WINDOW = 1_000_000
const OUTPUT_RESERVE = 256_000
const SESSION_ID = 'session-acceptance'

let seq = 0

/**
 * Build a fake Context plus a stand-in compaction engine.
 *
 * @param options - measured pressure and routed capacity for this scenario.
 * @returns the ctx, the engine, the agent, and the monitor path.
 */
function harness({ totalTokens, contextWindow = WINDOW, reservedCompletionTokens = OUTPUT_RESERVE, headerConfig = 'normal' }) {
  const monitorPath = join(tmpdir(), `dsh-compact-acceptance-${process.pid}-${seq++}.jsonl`)
  rmSync(monitorPath, { force: true })

  const agent = {
    // Before the first routed request the agent carries its target here.
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: {
      id: SESSION_ID,
      requestHeader() {
        if (headerConfig === null) return { config: null }
        return {
          config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: reservedCompletionTokens },
        }
      },
    },
    ctx: {},
  }

  /** Stand-in engine: records every entry, mirroring BasicCompactionEngine's entry point. */
  const entered = []
  const engine = {
    async compactIfNeeded(target, trigger) {
      entered.push(trigger)
      return { ran: trigger }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow }, defaultMaxTokens: reservedCompletionTokens }
      },
    },
    tokenMeter: {
      measureCalls: 0,
      measure() {
        this.measureCalls += 1
        return { totalTokens }
      },
    },
    agentPresets: { serviceFor: () => engine },
    inject(_deps, cb) {
      cb({ settings: { installSection(_c, _n, _s, resolved, options) { options?.setSource?.(resolved) } } })
    },
    on() {},
  }

  return { ctx, engine, agent, monitorPath, entered }
}

/** Read the monitor as parsed lines. */
function readMonitor(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const host = await import('../lib/index.js')

test('below the ratio the engine is never entered and the verdict is recorded', async () => {
  const h = harness({ totalTokens: 500_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.equal(result, null, 'below the ratio the check is suppressed')
  assert.deepEqual(h.entered, [], 'the engine must not be entered at all')

  const lines = readMonitor(h.monitorPath)
  const decision = lines.find((l) => l.decision !== undefined)
  assert.ok(decision, `a decision line must be recorded, got ${JSON.stringify(lines)}`)
  assert.equal(decision.decision, 'skip')
  assert.equal(decision.thresholdTokens, 900_000)
  assert.equal(decision.measuredTokens, 500_000)
  assert.equal(decision.contextWindow, WINDOW)
  assert.equal(decision.model, 'deepseek-flash')
  rmSync(h.monitorPath, { force: true })
})

test('at the ratio the check is handed to the engine', async () => {
  const h = harness({ totalTokens: 900_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  const result = await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(result, { ran: 'pressure' }, 'at the ratio the engine runs')
  assert.deepEqual(h.entered, ['pressure'])

  const decision = readMonitor(h.monitorPath).find((l) => l.decision !== undefined)
  assert.equal(decision.decision, 'delegate')
  rmSync(h.monitorPath, { force: true })
})

test('instrument is idempotent: repeated steps do not stack wrappers', async () => {
  const h = harness({ totalTokens: 900_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })

  // Many pre-steps, as a real session produces.
  for (let i = 0; i < 20; i += 1) wiring.instrument(h.agent)

  await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(h.entered, ['pressure'], 'one step must produce exactly one engine entry, not twenty')

  const lines = readMonitor(h.monitorPath)
  const attachLogs = lines.filter((l) => l.kind === 'instrument' && l.outcome === 'attached')
  assert.equal(attachLogs.length, 1, 'the engine must be attached exactly once')
  rmSync(h.monitorPath, { force: true })
})

test('a replaced engine instance is attached in turn', async () => {
  const h = harness({ totalTokens: 900_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  // A new preset generation yields a new engine object.
  const second = { entered: [], async compactIfNeeded(t, trigger) { this.entered.push(trigger); return { ran: trigger } } }
  h.ctx.agentPresets = { serviceFor: () => second }
  wiring.instrument(h.agent)

  await second.compactIfNeeded(h.agent, 'pressure', undefined)
  assert.deepEqual(second.entered, ['pressure'], 'the new engine must be wrapped too')
  rmSync(h.monitorPath, { force: true })
})

test('overflow recovery and manual triggers are never gated', async () => {
  const h = harness({ totalTokens: 10_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  assert.deepEqual(await h.engine.compactIfNeeded(h.agent, 'context-overflow', undefined), { ran: 'context-overflow' })
  assert.deepEqual(h.entered, ['context-overflow'], 'overflow passes straight through')

  const lines = readMonitor(h.monitorPath)
  assert.ok(!lines.some((l) => l.decision === 'skip'), 'overflow must never be suppressed')
  rmSync(h.monitorPath, { force: true })
})

test('the output floor opens the gate before the ratio', async () => {
  const h = harness({ totalTokens: 700_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, minOutputReserve: 100_000, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  assert.deepEqual(await h.engine.compactIfNeeded(h.agent, 'pressure', undefined), { ran: 'pressure' })
  const decision = readMonitor(h.monitorPath).find((l) => l.decision !== undefined)
  assert.equal(decision.decision, 'delegate', 'room below the floor must open the gate')
  rmSync(h.monitorPath, { force: true })
})

test('a settings refresh that omits monitorPath must not disable the monitor', async () => {
  const h = harness({ totalTokens: 500_000 })
  // Capture the setSource callback so the test can fire it the way a settings
  // document refresh would: with only the keys the user edited there.
  let fireSetSource = () => {}
  h.ctx.inject = (_deps, cb) => {
    cb({
      settings: {
        installSection(_c, _n, _s, resolved, options) {
          options?.setSource?.(resolved)
          fireSetSource = options?.setSource ?? (() => {})
        },
      },
    })
  }

  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  // A refresh carrying only two keys, as the settings document does.
  fireSetSource({ enabled: true, triggerRatio: 0.85 })

  assert.equal(
    wiring.policy.value.monitorPath,
    h.monitorPath,
    'monitorPath must survive a partial settings refresh',
  )

  await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  const decision = readMonitor(h.monitorPath).find((l) => l.decision !== undefined)
  assert.ok(decision, 'the monitor must still record verdicts after a settings refresh')
  assert.equal(decision.triggerRatio, 0.85, 'the refreshed ratio must be in effect')
  rmSync(h.monitorPath, { force: true })
})

test('before any routed request the agent options supply the target', async () => {
  // The real runtime case: on step one `requestHeader()` returns config: null,
  // so a gate that only reads the logged envelope stands down forever.
  const h = harness({ totalTokens: 500_000, headerConfig: null })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  assert.equal(await h.engine.compactIfNeeded(h.agent, 'pressure', undefined), null)

  const lines = readMonitor(h.monitorPath)
  assert.ok(
    !lines.some((l) => l.kind === 'gate-skip' && l.reason === 'no-routed-target'),
    'the engine options must supply the target before the first request',
  )
  const decision = lines.find((l) => l.decision !== undefined)
  assert.ok(decision, `a verdict must be reached, got ${JSON.stringify(lines)}`)
  assert.equal(decision.provider, 'deepseek-official')
  assert.equal(decision.decision, 'skip')
  rmSync(h.monitorPath, { force: true })
})

test('the step about to be sent is priced, not just the committed history', async () => {
  // At agent/pre-step the request does not exist yet, so measure() reports only
  // committed history. A gate that reads that alone sees 0 on step one and stays
  // open forever. The pending messages must be priced in.
  const h = harness({ totalTokens: 0 })
  let priced = 0
  h.ctx.tokenMeter.estimateMessage = () => {
    priced += 1
    return 300_000
  }

  // Capture the pre-step listener so the test can hand it the pending messages,
  // exactly as the agent loop does.
  let stepListener = null
  h.ctx.on = (event, listener) => {
    if (event === 'agent/pre-step') stepListener = listener
  }

  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  // Two pending messages: 0 surface + 2 x 300k = 600k, below the 900k trigger.
  stepListener({ agent: h.agent, messages: [{ role: 'user' }, { role: 'user' }] }, () => undefined)
  assert.equal(await h.engine.compactIfNeeded(h.agent, 'pressure', undefined), null)
  assert.equal(priced, 2, 'each pending message must be priced once')

  let decision = readMonitor(h.monitorPath).find((l) => l.decision !== undefined)
  assert.equal(decision.measuredTokens, 600_000)
  assert.equal(decision.surfaceTokens, 0)
  assert.equal(decision.pendingTokens, 600_000)
  assert.equal(decision.decision, 'skip')

  // Three pending messages: 900k, exactly at the trigger, so the gate opens.
  stepListener({ agent: h.agent, messages: [{ role: 'user' }, { role: 'user' }, { role: 'user' }] }, () => undefined)
  assert.deepEqual(await h.engine.compactIfNeeded(h.agent, 'pressure', undefined), { ran: 'pressure' })
  decision = readMonitor(h.monitorPath).filter((l) => l.decision !== undefined).pop()
  assert.equal(decision.measuredTokens, 900_000)
  assert.equal(decision.decision, 'delegate')

  rmSync(h.monitorPath, { force: true })
})

test('far below the trigger the O(surface) meter is not repeated every step', async () => {
  // 100k of a 900k trigger: ~50x headroom, and pressure rises by hundreds of
  // tokens per step, so re-pricing the whole surface each step buys nothing.
  const h = harness({ totalTokens: 100_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  for (let i = 0; i < 5; i += 1) {
    await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  }

  assert.equal(h.ctx.tokenMeter.measureCalls, 1, 'the surface must be priced once, not five times')

  const lines = readMonitor(h.monitorPath).filter((l) => l.decision !== undefined)
  assert.equal(lines.length, 5, 'every step still produces a verdict')
  assert.equal(lines[0].surfaceReused, false, 'the first step measures')
  assert.ok(lines.slice(1).every((l) => l.surfaceReused === true), 'later steps reuse the priced surface')
  assert.ok(lines.every((l) => l.decision === 'skip'))

  rmSync(h.monitorPath, { force: true })
})

test('near the trigger every step is measured so the crossing is not overshot', async () => {
  // 890k against a 900k trigger is inside the 2% near-window.
  const h = harness({ totalTokens: 890_000 })
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  for (let i = 0; i < 3; i += 1) {
    await h.engine.compactIfNeeded(h.agent, 'pressure', undefined)
  }

  assert.equal(h.ctx.tokenMeter.measureCalls, 3, 'near the threshold the meter must run every step')
  const lines = readMonitor(h.monitorPath).filter((l) => l.decision !== undefined)
  assert.ok(lines.every((l) => l.surfaceReused === false))
  assert.ok(lines.every((l) => l.decision === 'skip'))

  rmSync(h.monitorPath, { force: true })
})

test('a broken measurement fails open and is recorded, not swallowed', async () => {
  const h = harness({ totalTokens: 1 })
  h.ctx.tokenMeter.measure = () => { throw new Error('meter exploded') }
  const wiring = host.apply(h.ctx, { triggerRatio: 0.9, monitorPath: h.monitorPath })
  wiring.instrument(h.agent)

  assert.deepEqual(await h.engine.compactIfNeeded(h.agent, 'pressure', undefined), { ran: 'pressure' })
  const err = readMonitor(h.monitorPath).find((l) => l.kind === 'gate-error')
  assert.ok(err, 'the failure must be recorded in the monitor')
  assert.match(err.error, /meter exploded/)
  rmSync(h.monitorPath, { force: true })
})
