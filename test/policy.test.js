/**
 * Unit tests for the pure trigger policy.
 *
 * These assert the numbers that motivated the plugin: the user's real deployment
 * is a 1,000,000-token window with a 256,000-token output reservation, where the
 * stock DSH trigger is 678,464 (67.85%) and a 0.9 ratio must be exactly 900,000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  POLICY_DEFAULTS,
  computeRoomTokens,
  computeTriggerTokens,
  decide,
  describeDecision,
  normalizePolicy,
  parseRouteList,
  routeMatches,
} from '../lib/policy.js'

const WINDOW = 1_000_000
const OUTPUT_RESERVE = 256_000

test('defaults gate at 0.9 and carry no output floor', () => {
  assert.equal(POLICY_DEFAULTS.triggerRatio, 0.9)
  assert.equal(POLICY_DEFAULTS.minOutputReserve, 0)
  assert.equal(POLICY_DEFAULTS.enabled, true)
  assert.equal(POLICY_DEFAULTS.dryRun, false)
})

test('trigger is exactly floor(ratio * window), with no headroom subtraction', () => {
  assert.equal(computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 0.9 }), 900_000)
  assert.equal(computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 0.8 }), 800_000)
  // 678,464 is what stock DSH computes on this window. The wheel must not.
  assert.notEqual(computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 0.9 }), 678_464)
})

test('the output reservation cannot move the trigger', () => {
  // The trigger is a function of window and ratio alone. The reservation only
  // participates in the optional room guard, never in the trigger.
  const trigger = computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 0.9 })
  assert.equal(trigger, 900_000)
  assert.equal(
    computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 0.9, reservedCompletionTokens: 0 }),
    900_000,
  )
  assert.equal(
    computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 0.9, reservedCompletionTokens: OUTPUT_RESERVE }),
    900_000,
  )
})

test('an unusable window is reported rather than guessed', () => {
  assert.equal(computeTriggerTokens({ contextWindow: 0, triggerRatio: 0.9 }), undefined)
  assert.equal(computeTriggerTokens({ contextWindow: -1, triggerRatio: 0.9 }), undefined)
  assert.equal(computeTriggerTokens({ contextWindow: 1.5, triggerRatio: 0.9 }), undefined)
  assert.equal(computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 0 }), undefined)
  assert.equal(computeTriggerTokens({ contextWindow: WINDOW, triggerRatio: 1.5 }), undefined)
  assert.equal(computeTriggerTokens({}), undefined)
})

test('just below the ratio is suppressed, at the ratio it is handed back', () => {
  const base = {
    policy: normalizePolicy({ triggerRatio: 0.9 }),
    target: { provider: 'deepseek-official', model: 'deepseek-flash' },
    contextWindow: WINDOW,
    reservedCompletionTokens: OUTPUT_RESERVE,
  }
  assert.equal(decide({ ...base, totalTokens: 899_999 }), 'skip')
  assert.equal(decide({ ...base, totalTokens: 900_000 }), 'delegate')
  assert.equal(decide({ ...base, totalTokens: 950_000 }), 'delegate')
})

test('stock behaviour is reproduced when the plugin is disabled', () => {
  const policy = normalizePolicy({ enabled: false, triggerRatio: 0.9 })
  assert.equal(
    decide({
      policy,
      target: { provider: 'deepseek-official', model: 'deepseek-flash' },
      contextWindow: WINDOW,
      reservedCompletionTokens: OUTPUT_RESERVE,
      totalTokens: 700_000,
    }),
    'delegate',
  )
})

test('route filter narrows the gate and an empty filter stands down', () => {
  const covered = normalizePolicy({ routes: 'deepseek-official/deepseek-flash' })
  const other = { provider: 'xai', model: 'grok' }
  assert.equal(
    decide({ policy: covered, target: other, contextWindow: WINDOW, totalTokens: 100 }),
    'delegate',
  )
  const empty = normalizePolicy({ routes: '' })
  assert.equal(decide({ policy: empty, contextWindow: WINDOW, totalTokens: 100 }), 'delegate')
  assert.deepEqual(parseRouteList(''), [])
  assert.equal(routeMatches(parseRouteList('*'), other), true)
  assert.equal(routeMatches(parseRouteList('deepseek-official'), { provider: 'deepseek-official', model: 'anything' }), true)
})

test('an unmeasurable check is always handed back', () => {
  const policy = normalizePolicy({ triggerRatio: 0.9 })
  assert.equal(decide({ policy, contextWindow: undefined, totalTokens: 1 }), 'delegate')
  assert.equal(decide({ policy, contextWindow: WINDOW, totalTokens: Number.NaN }), 'delegate')
})

test('the output floor opens the gate early, and only below the ratio', () => {
  const policy = normalizePolicy({ triggerRatio: 0.9, minOutputReserve: 100_000 })

  // Room = W - O - measured. At 900,000 measured the room is 900,000 - 256,000 = ...
  // measured 700,000 -> room = 1,000,000 - 256,000 - 700,000 = 44,000 < 100,000 -> open early.
  assert.equal(computeRoomTokens({ contextWindow: WINDOW, reservedCompletionTokens: OUTPUT_RESERVE, totalTokens: 700_000 }), 44_000)
  assert.equal(
    decide({ policy, contextWindow: WINDOW, reservedCompletionTokens: OUTPUT_RESERVE, totalTokens: 700_000 }),
    'delegate',
  )

  // Same floor, comfortable room: still too early, so it stays suppressed.
  assert.equal(
    decide({ policy, contextWindow: WINDOW, reservedCompletionTokens: OUTPUT_RESERVE, totalTokens: 600_000 }),
    'skip',
  )

  // Zero floor restores ratio-only behaviour.
  const ratioOnly = normalizePolicy({ triggerRatio: 0.9, minOutputReserve: 0 })
  assert.equal(
    decide({ policy: ratioOnly, contextWindow: WINDOW, reservedCompletionTokens: OUTPUT_RESERVE, totalTokens: 700_000 }),
    'skip',
  )
})

test('normalizePolicy survives volatile cells and emptied inputs', () => {
  const cell = (v) => ({ get: () => v })
  const fromCells = normalizePolicy({
    enabled: cell(true),
    routes: cell('deepseek-official'),
    triggerRatio: cell(0.85),
    minOutputReserve: cell(32768),
  })
  assert.deepEqual(fromCells, {
    enabled: true,
    routes: 'deepseek-official',
    triggerRatio: 0.85,
    minOutputReserve: 32768,
    dryRun: false,
    monitorPath: '',
    measureIntervalMs: 15000,
  })

  // A zero interval is a legal explicit value: it restores "measure every step".
  assert.equal(normalizePolicy({ measureIntervalMs: 0 }).measureIntervalMs, 0)

  // The monitor path is a plain string and survives a cell read.
  assert.equal(normalizePolicy({ monitorPath: cell('C:/tmp/m.jsonl') }).monitorPath, 'C:/tmp/m.jsonl')

  // An emptied number input means "unset", so the default applies.
  assert.equal(normalizePolicy({ triggerRatio: '' }).triggerRatio, POLICY_DEFAULTS.triggerRatio)
  assert.equal(normalizePolicy({ minOutputReserve: '' }).minOutputReserve, 0)
  // A thrown cell must not crash normalization.
  assert.equal(normalizePolicy({ triggerRatio: { get: () => { throw new Error('gone') } } }).triggerRatio, POLICY_DEFAULTS.triggerRatio)
  // Garbage input falls back wholesale.
  assert.deepEqual(normalizePolicy(null), { ...POLICY_DEFAULTS })
  assert.deepEqual(normalizePolicy('nonsense'), { ...POLICY_DEFAULTS })
})

test('describeDecision reports the numbers an operator needs', () => {
  const policy = normalizePolicy({ triggerRatio: 0.9 })
  const line = describeDecision({
    policy,
    contextWindow: WINDOW,
    reservedCompletionTokens: OUTPUT_RESERVE,
    totalTokens: 500_000,
    decision: 'skip',
  })
  assert.match(line, /decision=skip/)
  assert.match(line, /threshold=900000 \(90\.00%\)/)
  assert.match(line, /measured=500000/)
  assert.match(line, /room=244000/)
})
