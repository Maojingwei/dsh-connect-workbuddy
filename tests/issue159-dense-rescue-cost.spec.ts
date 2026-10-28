/**
 * The dense rescue rung must be FAST, and must still send the same bytes.
 *
 * WHAT ISSUE #159 REPORTED, AND WHAT THIS FILE DOES AND DOES NOT COVER. #159
 * reports that the three-rung channel rescue never ran at all — empty
 * `retries` in the reply — and concludes from that symptom that the
 * `!controller.signal.aborted` guard on each rung must have been true. That
 * conclusion is not established by the evidence in the issue, and the proposed
 * one-line patch has a measured, worse consequence (see
 * `tests/issue159-abort-gate.spec.ts`, which pins the actual contract of that
 * guard). What #159's report DID surface, and what this file fixes, is a
 * separate and far more ordinary reason the ladder can fail to help on exactly
 * the body it was reported against: a 130,345-character `system` message.
 *
 * THE DEFECT. `perturbChannelFingerprints(body, true)` — the dense, last-resort
 * rung — inserted its breaks with a `replace` callback that, for EVERY match
 * position, re-derived "the previous non-space rune" by slicing the prefix and
 * running a regex over it:
 *
 *     const previous = source.slice(0, offset).match(/\S(?=\S*$)/u)?.[0]
 *
 * That is O(offset) work per position, i.e. O(n²) in body size. Measured on the
 * machine that wrote this file (Node 25, 2026-10-28), before the change:
 *
 *     body    11,575 chars →   1.3 s
 *     body    23,075 chars →   5.2 s
 *     body    46,075 chars →  22.8 s
 *     body    92,075 chars →  82.7 s
 *     body   184,075 chars → 322.8 s
 *
 * A body of 92 KB is an ordinary long DSH session, and the field system prompt
 * in #159 is 130 KB. So on precisely the requests that need the rescue most, the
 * dense rung spent minutes before sending anything — while the reader waited on
 * a request whose own HTTP call has no ceiling of its own by design
 * (`chatStream` documents why). The rescue could be overtaken by the reader, and
 * the turn then looks exactly like a rescue that never happened.
 *
 * THE FIX is a one-pass accumulator. It is a PERFORMANCE change only: the
 * function's output must stay byte-identical, quirks included, because a
 * different body would be one nobody measured. The tests below therefore pin
 * BOTH properties — the old output (against a literal transcription) and the
 * new cost.
 *
 * @module dsh-connect-workbuddy/tests/issue159-dense-rescue-cost
 */
import { describe, expect, it } from 'vitest'
import { perturbChannelFingerprints } from '../src/upstream.ts'

const ZERO_WIDTH_SPACE = '\u200b'

/**
 * The PRE-FIX dense rule, transcribed literally.
 *
 * Kept here rather than imported from git history so the equality test cannot
 * silently compare a function against itself: the reference has to keep working
 * with the old shape `source.slice(0, offset)…`, which the fix deletes.
 */
function legacyDense(text: string): string {
  return text.replace(
    /(?=\S)/gu,
    (_whole: string, offset: number, source: string) => {
      if (source.slice(Math.max(0, offset - 1), offset + 1).includes(ZERO_WIDTH_SPACE)) return ''
      const previous = source.slice(0, offset).match(/\S(?=\S*$)/u)?.[0]
      return previous !== undefined && /[A-Za-z0-9぀-ヿ㐀-鿿]/u.test(previous)
        ? ZERO_WIDTH_SPACE
        : ''
    },
  )
}

/** The scanned text of the first message, after the function has run on it. */
function denseTextOf(text: string): string | undefined {
  const body = JSON.stringify({ messages: [{ role: 'system', content: text }] })
  const out = perturbChannelFingerprints(body, true)
  if (out === undefined) return undefined
  return (JSON.parse(out) as { messages: Array<{ content: string }> }).messages[0]?.content
}

describe('the dense rescue rung: output is unchanged by the speed fix', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['plain words', 'hello world this is prose without punctuation'],
    ['sentence punctuation', 'One. Two! Three? Four, five; six'],
    ['cjk', '你好。世界！这是测试'],
    ['mixed scripts', 'DeepSeek Harness 你好 world。Next'],
    ['already broken', `hello${ZERO_WIDTH_SPACE}world again`],
    ['several breaks', `a${ZERO_WIDTH_SPACE}b${ZERO_WIDTH_SPACE}c`],
    ['break then space', `hello${ZERO_WIDTH_SPACE} world`],
    ['newlines', 'line one\nline two\n\nline three'],
    ['tabs', 'a\tb\t c'],
    ['digits and dots', 'v4.1-flash 2026 10 28'],
    ['empty', ''],
    ['spaces only', '   '],
    ['leading break', `${ZERO_WIDTH_SPACE}abc`],
    ['trailing break', `abc${ZERO_WIDTH_SPACE}`],
    ['punctuation only', '... ;;; ,,,'],
    ['double space', 'word  word'],
    ['single rune', 'a'],
    ['product names', 'powered by DeepSeek Harness and Visual Studio'],
    ['no punctuation', 'You are an AI agent powered by DeepSeek Harness'],
    ['emoji', 'hi 😀 there 🎉 friend'],
    ['ideographic space', `a\u3000b`],
    ['combining mark', `e\u0301clair`],
  ]

  for (const [name, text] of CASES) {
    it(`matches the pre-fix rule: ${name}`, () => {
      // `perturbChannelFingerprints` runs the SPARSE rules first and then, in
      // dense mode, spaces what they produced — so the reference is built the
      // same way: sparse output, then the legacy dense rule over it.
      const sparseOnly = perturbChannelFingerprints(JSON.stringify({ messages: [{ role: 'system', content: text }] }))
      const sparseText = sparseOnly === undefined
        ? text
        : (JSON.parse(sparseOnly) as { messages: Array<{ content: string }> }).messages[0]?.content ?? text
      const expected = legacyDense(sparseText)
      const actual = denseTextOf(text)
      expect(actual === undefined ? text : actual).toBe(expected)
    })
  }

  it('matches the pre-fix rule on a seeded random corpus', () => {
    // Deterministic on purpose: a failure must be reproducible from the message.
    // The alphabet deliberately mixes word runes, NON-word runes, whitespace of
    // both widths, CJK punctuation and pre-existing breaks, because the old rule
    // behaved differently at the start of a run of non-space runes than inside
    // one — which is the exact subtlety a naive rewrite gets wrong.
    const alphabet = [
      'a', 'B', '9', ' ', '\n', '\t', '.', '!', '?', ',', ';', '。', '！', '你', '好',
      ZERO_WIDTH_SPACE, '😀', '"', '-', '\u3000', 'é', 'ß', '\u0301', '~', '/',
    ]
    let seed = 1_234_567
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let trial = 0; trial < 1500; trial += 1) {
      let text = ''
      const length = Math.floor(next() * 120)
      for (let index = 0; index < length; index += 1) {
        text += alphabet[Math.floor(next() * alphabet.length)]
      }
      const sparseOnly = perturbChannelFingerprints(JSON.stringify({ messages: [{ role: 'system', content: text }] }))
      const sparseText = sparseOnly === undefined
        ? text
        : (JSON.parse(sparseOnly) as { messages: Array<{ content: string }> }).messages[0]?.content ?? text
      const expected = legacyDense(sparseText)
      const actual = denseTextOf(text)
      expect(actual === undefined ? text : actual, `trial ${trial}: ${JSON.stringify(text)}`).toBe(expected)
    }
  })
})

describe('the dense rescue rung: cost stays linear in body size', () => {
  /**
   * A real session shape: prose without punctuation is the hardest case for the
   * sparse rules and the reason the dense rung exists at all.
   */
  function bodyOf(chars: number): string {
    return JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'Some long rules block. '.repeat(Math.ceil(chars / 25)) },
        { role: 'user', content: 'hi' },
      ],
    })
  }

  it('rescues a 130 KB system prompt well inside a reader’s patience', () => {
    // 130,345 characters is the `system` message issue #159 was reported
    // against. This assertion is deliberately about WALL CLOCK, because that is
    // the property that was broken: the old rule needed ~165 s here (measured;
    // it is quadratic, so the exact figure depends on the machine), and the
    // point of the fix is that the rung now finishes in milliseconds.
    const body = bodyOf(130_000)
    const started = Date.now()
    const out = perturbChannelFingerprints(body, true)
    const elapsed = Date.now() - started
    expect(out, 'the dense rung produced no body at all').toBeDefined()
    expect(elapsed, `dense rescue took ${elapsed}ms on ${body.length} chars`).toBeLessThan(2_000)
  })

  it('cost grows with the body, not with its SQUARE', () => {
    // AN ABSOLUTE CEILING AT A SIZE WHERE THE TWO IMPLEMENTATIONS DIFFER BY
    // ORDERS OF MAGNITUDE — not a ratio of two small samples.
    //
    // A ratio was tried first and it is the wrong instrument here. Measured on
    // CI (ubuntu, 2026-10-28): 60 KB took 10 ms and 120 KB took 34 ms, i.e. a
    // "ratio" of 3.4 against a 3x ceiling — a FAILURE for a correct linear
    // implementation. At single-digit-millisecond scale the ratio measures timer
    // granularity, GC and the fixed per-call pass, not the growth being claimed.
    // Meanwhile a genuinely quadratic rule at that size is still only
    // milliseconds, so the ratio cannot discriminate at 60 KB either way.
    //
    // The discriminating size is a big one. Measured on the development machine
    // (median of 5, after a warm-up): 40 KB 3.5 ms, 80 KB 7.3 ms, 160 KB 11.2 ms,
    // 320 KB 28.8 ms, 640 KB 69.3 ms — clean ~2x per doubling. The OLD rule at
    // 92 KB took 82.7 s, so at 320 KB it lands around fifteen MINUTES. Any
    // ceiling in between separates the two decisively, with no noise problem:
    // 5 s is ~170x the linear implementation's headroom on a fast machine and
    // still more than two orders of magnitude below the quadratic one.
    const measure = (chars: number): number => {
      const body = bodyOf(chars)
      const started = performance.now()
      const out = perturbChannelFingerprints(body, true)
      const elapsed = performance.now() - started
      expect(out, 'the dense rung produced no body at all').toBeDefined()
      return elapsed
    }
    // Warm up so the first measured call does not pay for JIT compilation.
    measure(40_000)
    // Median of three, so one scheduling hiccup on a shared CI runner cannot
    // turn this into a flaky failure.
    const samples = [measure(320_000), measure(320_000), measure(320_000)].sort((a, b) => a - b)
    const median = samples[1] as number
    expect(median, `dense rescue took ${median.toFixed(1)}ms on a 320 KB body`).toBeLessThan(5_000)
  })
})
