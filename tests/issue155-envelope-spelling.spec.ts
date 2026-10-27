/**
 * Issue #155: the SAME refusal must classify the same way whatever the envelope's
 * JSON spelling is.
 *
 * THE REPORT, VERBATIM FROM THE ISSUE BODY. A user pasted the reply they got:
 *
 *   workbuddy 上游失败：请求被上游拒绝（http 400）（code 11128，requestId 31a97b9f-…）
 *   …该请求被上游按参数拒绝…
 *   "type":"client","code":"client"
 *
 * One body, two contradictory statements inside it. `code 11128` was read by
 * `JSON.parse` (via `parseUpstreamErrorDetail`), while `client` was decided by
 * `classifyUpstreamError`, which recognised the `11128` family with
 * `body.includes('"code":11128')` — a byte test on ONE serialization. The two
 * agree only when the upstream happens to emit compact JSON.
 *
 * WHY THIS IS NOT A PROSE BUG. `client` is the one kind that does NOT enter the
 * channel rescue ladder (`src/shim.ts` gates it on `kind === 'channel_reject'`),
 * so `forceNeutralHead` and both perturbation rungs never fire. The reply then
 * tells the user to "adjust the request" for a refusal the plugin had not
 * actually tried to rescue — and #113's fix (recognise the family by its CODE so
 * the ladder always runs) silently switches off depending on a space.
 *
 * ISSUE #127 ALREADY BOUGHT THIS, AND ONLY HALF OF IT. That fix introduced
 * `businessCodeOf` and moved `11140` / `14018` onto it; `11128` and `14003` were
 * left on the substring. So CHANGELOG 5.8.0's「按信封里的业务码判定（不再依赖某种
 * JSON 拼法）」and the pinned #125 §1「按 code 识别」were true for the policy family
 * and false for the channel family. These tests are that claim, made checkable
 * across every family in the classifier.
 *
 * WHAT EACH CASE IS FOR.
 *   - `compact`  — the shipped gateway shape; the baseline that already passed.
 *   - `spaced`   — a proxy or re-serializer that pretty-prints. #155's row.
 *   - `string`   — `"code":"11128"`, which the docs already name as a hazard.
 *   - `nested`   — a code below the three shapes `businessCodeOf` knows. Kept
 *                  because the old text match DID catch these: dropping them
 *                  would be a regression dressed up as a refactor.
 *   - `unknown`  — no stated code at all; must stay `client`, so a red herring
 *                  cannot promote a body into a family.
 * The last one is the counterweight: this fix must widen recognition without
 * weakening the "code, never prose" rule.
 *
 * @module dsh-connect-workbuddy/tests/issue155-envelope-spelling
 */

import { describe, expect, it } from 'vitest'
import {
  classifyUpstreamError,
  isChannelGateFamilyBody,
  isConversationIdGateBody,
  isFirstMessageGateBody,
  isModelBusyBody,
  parseUpstreamErrorDetail,
} from '../src/upstream.ts'

/** The four spellings of one business code, plus one body that states none. */
function spellings(code: number, msg: string): [string, string][] {
  return [
    ['compact', `{"code":${code},"msg":"${msg}","requestId":"31a97b9f-aa3e"}`],
    ['spaced', `{"code": ${code},"msg":"${msg}","requestId":"31a97b9f-aa3e"}`],
    ['string code', `{"code":"${code}","msg":"${msg}","requestId":"31a97b9f-aa3e"}`],
    ['nested error.code', `{"error":{"code":${code},"msg":"${msg}"}}`],
  ]
}

/** The channel gate as #155 reported it, with the tips sentence it carried. */
const CHANNEL_MSG = 'Illegal API invocation from an unapproved channel'

describe('the 11128 family classifies identically across JSON spellings (issue #155)', () => {
  for (const [label, body] of spellings(11128, CHANNEL_MSG)) {
    it(label, () => {
      expect(classifyUpstreamError(400, body)).toBe('channel_reject')
      expect(isChannelGateFamilyBody(body)).toBe(true)
    })
  }

  it('and the classifier never disagrees with the detail the user is shown', () => {
    // The whole of the report: `code 11128` and `"type":"client"` came from the
    // same bytes. Classification and display must read ONE fact, not two — so
    // for every spelling, either both see the family or neither does.
    for (const [label, body] of spellings(11128, CHANNEL_MSG)) {
      const detail = parseUpstreamErrorDetail(body)
      const seesTheCode = detail?.upstreamCode === 11128
      expect(
        [seesTheCode, classifyUpstreamError(400, body) === 'channel_reject'],
        label,
      ).toEqual([true, true])
    }
  })

  it('names the member of the family through the spaced spelling too', () => {
    // `shim.ts` picks the ADVICE with these two, and a member that silently
    // stops matching degrades the reply to "the gate did not say which".
    expect(isConversationIdGateBody('{"code": 11128,"msg":"conversation id missing"}')).toBe(true)
    expect(isFirstMessageGateBody('{"code": 11128,"msg":"first message is not system prompt"}')).toBe(true)
  })

  it('matches case-insensitively, which the family half used to fail at', () => {
    // A RESTORATION, not a preservation, and the split is the interesting part:
    // at HEAD the MEMBER predicates lower-cased the body before testing (so
    // `{"CODE":11128,…}` matched them — pinned by `tests/issue98-channel-gate`),
    // while `isChannelGateFamilyBody` tested the RAW body and did NOT. Measured:
    // `{"CODE":11128,…}` classified `client` at HEAD. One reader now answers both
    // halves, so a member match can never rest on a family that missed it.
    expect(classifyUpstreamError(400, '{"CODE":11128,"msg":"x"}')).toBe('channel_reject')
    expect(isChannelGateFamilyBody('{"CODE":11128,"msg":"x"}')).toBe(true)
  })
})

describe('the other business codes got the same treatment (issue #155)', () => {
  for (const [label, body] of spellings(14003, 'too many requests')) {
    it(`model_busy: ${label} is not demoted to client`, () => {
      // `model_busy` carries its own non-failover semantics and the "switch to
      // another model" advice; `client` gives neither.
      expect(classifyUpstreamError(400, body)).toBe('model_busy')
      expect(isModelBusyBody(body)).toBe(true)
    })
  }

  for (const [label, body] of spellings(14018, 'Credits exhausted. Please visit the site')) {
    it(`hard_credit: ${label}`, () => {
      expect(classifyUpstreamError(400, body)).toBe('hard_credit')
    })
  }

  for (const [label, body] of spellings(11140, 'request illegal')) {
    it(`content policy: ${label}`, () => {
      // Pre-existing behaviour, pinned here because 11140 is the family #127
      // already moved onto the parser: a nested spelling the parser cannot reach
      // must still land on policy, not fall through to `client`.
      expect(['policy_reject', 'account_restricted']).toContain(classifyUpstreamError(400, body))
    })
  }
})

describe('widening recognition does not weaken the code rule (issue #155)', () => {
  it('a body that states no business code stays `client`', () => {
    const body = '{"message":"internal gateway error","status":500}'
    expect(classifyUpstreamError(400, body)).toBe('client')
    expect(isChannelGateFamilyBody(body)).toBe(false)
  })

  it('a hexadecimal request id containing 11128 is not the family', () => {
    // The reason the scan anchors on `"code":<n>` rather than the bare digits.
    const body = '{"requestId":"aa11128bbc","msg":"ok"}'
    expect(classifyUpstreamError(400, body)).toBe('client')
    expect(isChannelGateFamilyBody(body)).toBe(false)
  })

  it('a nested 11128 does not override an envelope whose own verdict is 14003', () => {
    // The ordering inside `statesBusinessCode`: a code the envelope STATES is
    // final, so a detail cannot be promoted over the verdict.
    const body = '{"code":14003,"extError":{"code":11128,"param":"model"}}'
    expect(classifyUpstreamError(400, body)).toBe('model_busy')
  })

  it('a foreign code quoting the shared tips sentence is still not the family', () => {
    expect(classifyUpstreamError(400, '{"code": 11140,"msg":"request illegal","displayTips":{"zh":"这次调用没通过渠道校验。"}}'))
      .toBe('policy_reject')
  })
})
