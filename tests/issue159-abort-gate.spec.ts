/**
 * The abort gate on the channel-rescue ladder: what it is FOR, and why removing
 * it is not the fix issue #159 proposed.
 *
 * WHAT #159 CLAIMS. The issue reports two turns that failed with `11128` whose
 * reply carried no `retries` note, i.e. all three rescue rungs reported as not
 * run, and infers from that symptom that `!controller.signal.aborted` was false
 * on entry. It then proposes deleting the three `&& !controller.signal.aborted`
 * clauses outright, on the argument that "the abort is already enforced inside
 * `chatStream`, so the outer check is a redundant and harmful duplicate".
 *
 * WHY THAT ARGUMENT DOES NOT HOLD, measured on this tree (2026-10-28):
 *
 *  1. The signal is ONLY ever aborted by `res.on('close')`, i.e. an actual
 *     socket teardown — a reader that is gone. There is no second, "host
 *     internal" abort source in this shim to distinguish it from (the issue's
 *     premise is a signal the plugin does not have). A reader that is gone is
 *     precisely the case the guard exists for.
 *
 *  2. `chatStream` does NOT "already guarantee" the abort in a way that makes
 *     the rung harmless. Removing the guard makes the shim CALL `chatStream`
 *     again, and what comes back is `{status: 0, kind: 'server'}` (an aborted
 *     `fetch` rejects and is caught as a transport failure). That OVERWRITES
 *     the real `channel_reject` diagnosis, so the reader is told "upstream
 *     server error" instead of "the gateway refused this request" — and
 *     `reportFailures` then books a bogus account failure for a request that
 *     never reached the wire. Both are asserted below.
 *
 *  3. The cost the issue waves away is not just "one extra function call": on a
 *     large body the dense rung used to take minutes of SYNCHRONOUS CPU to build
 *     its body (see `issue159-dense-rescue-cost.spec.ts`), so spending it for a
 *     reader that has already hung up is not free.
 *
 * The rungs still run in the case that matters and that the issue is right to
 * care about: a refusal on a live request. That is pinned by
 * `issue113-channel-gate-evidence.spec.ts` and `issue98-shim.spec.ts`, which
 * make several real rescue attempts on an open connection. What this file adds is
 * the OTHER half — that a hang-up must not rewrite the diagnosis.
 *
 * @module dsh-connect-workbuddy/tests/issue159-abort-gate
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { classifyUpstreamError, parseUpstreamErrorDetail } from '../src/upstream.ts'
import type { WorkBuddyChatResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** The live CN gateway's channel-gate reply. */
const CHANNEL_REJECT_BODY = JSON.stringify({
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  requestId: '01a17e3e61d479aba4d039fc434505b2',
})

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  uin: 'selected',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const store = {
  resolve: async () => CREDENTIAL,
  credentialFor: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

function channelReject(): WorkBuddyChatResult {
  return {
    ok: false,
    status: 400,
    kind: classifyUpstreamError(400, CHANNEL_REJECT_BODY),
    message: CHANNEL_REJECT_BODY,
    detail: parseUpstreamErrorDetail(CHANNEL_REJECT_BODY),
  }
}

/**
 * What a REAL `chatStream` returns once its signal is aborted: `fetch` rejects
 * with `AbortError`, and the client's catch reports it as a transport failure
 * with no HTTP status at all.
 */
function transportedAbort(): WorkBuddyChatResult {
  return { ok: false, status: 0, kind: 'server', message: 'transport error: AbortError' }
}

/** A body whose scanned message really can be re-shaped by every rung. */
const REQUESTED_BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
    { role: 'user', content: 'hi' },
  ],
})

let shim: WorkBuddyShim | undefined
afterEach(async () => {
  await shim?.close()
  shim = undefined
})

interface Mounted {
  instance: WorkBuddyShim
  /** Bodies actually sent, in order. */
  sent: string[]
  /** True when the shim called the client while the signal was already aborted. */
  calledAfterAbort: () => number
  reported: Array<{ accountId: string, kind: string }>
}

function mount(script: {
  first: () => Promise<WorkBuddyChatResult>
}): Mounted {
  const sent: string[] = []
  let afterAbort = 0
  const reported: Array<{ accountId: string, kind: string }> = []
  const instance = createWorkBuddyShim({
    store,
    client: {
      chatStream: async (
        _credential: WorkBuddyCredential,
        bodyJson: string,
        signal?: AbortSignal,
      ): Promise<WorkBuddyChatResult> => {
        sent.push(bodyJson)
        // The REAL client short-circuits here; counting it is what makes the
        // difference between "spent a call" and "spent nothing" observable.
        if (signal?.aborted === true) {
          afterAbort += 1
          return transportedAbort()
        }
        if (sent.length === 1) return script.first()
        return channelReject()
      },
    } as unknown as WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
    onAccountFailure: (accountId, failure) => {
      reported.push({ accountId, kind: failure.kind })
    },
    logger: { warn: vi.fn(), error: vi.fn() } as unknown as { warn: () => void, error: () => void },
  })
  return { instance, sent, calledAfterAbort: () => afterAbort, reported }
}

/**
 * Drive one chat over a RAW socket so the test controls the hang-up.
 *
 * `fetch` cannot express this: an aborted `fetch` never reaches the wire, so
 * the shim's `res.on('close')` — the only thing that aborts its controller —
 * would never fire.
 */
async function chatThenHangUp(
  instance: WorkBuddyShim,
  onFirstAttemptInFlight: () => void,
): Promise<{ received: string }> {
  await instance.ready
  const url = new URL(instance.baseUrl())
  const { connect } = await import('node:net')
  const socket = connect(Number(url.port), url.hostname)
  await new Promise<void>(resolve => socket.once('connect', () => resolve()))

  let received = ''
  socket.on('data', (chunk: Buffer) => { received += chunk.toString() })
  socket.on('error', () => { /* the hang-up itself; the shim must cope */ })

  socket.write(
    'POST /v1/chat/completions HTTP/1.1\r\n'
    + `Host: 127.0.0.1:${url.port}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Authorization: Bearer ${instance.token()}\r\n`
    + `Content-Length: ${Buffer.byteLength(REQUESTED_BODY)}\r\n\r\n${REQUESTED_BODY}`,
  )

  onFirstAttemptInFlight()
  // Let the first attempt be refused and the close event land before the hang-up
  // is released, so the guard is evaluated against an aborted signal rather than
  // racing it.
  await new Promise(resolve => setTimeout(resolve, 60))
  socket.destroy()
  await new Promise(resolve => setTimeout(resolve, 150))
  return { received }
}

describe('issue #159: the abort gate protects the DIAGNOSIS, not just quota', () => {
  it('a hang-up does not let the rescue overwrite the channel diagnosis', async () => {
    // The scenario the issue calls a bug. With the guard in place the shim
    // answers exactly what it already knows — a channel refusal — instead of
    // replacing it with a transport error caused by our own abort.
    let releaseFirst: () => void = () => {}
    const firstInFlight = new Promise<void>(resolve => { releaseFirst = resolve })
    const mounted = mount({
      first: async () => {
        releaseFirst()
        // Hold the attempt open so the hang-up lands while it is in flight.
        await new Promise(resolve => setTimeout(resolve, 80))
        return channelReject()
      },
    })
    shim = mounted.instance

    await chatThenHangUp(shim, () => {})

    // The reader is gone, so no reply is inspectable — but what matters is that
    // the shim did NOT spend a rescue on a dead socket and did NOT mis-book the
    // account. Both are the contract the removed guard would break.
    expect(mounted.calledAfterAbort(), 'the shim spent a rescue on an aborted signal').toBe(0)
    expect(mounted.sent, 'exactly the one attempt that was already in flight').toHaveLength(1)
    expect(mounted.reported, 'an aborted request must leave no measurement').toEqual([])
    expect(await firstInFlight, 'the in-flight attempt really was in flight').toBeUndefined()
  })

  it('sanity: the SAME response on a LIVE request runs the whole ladder', async () => {
    // The counterpart assertion, so the test above cannot pass by the ladder
    // being broken in general. A reader that is still there gets rescued.
    const mounted = mount({ first: async () => channelReject() })
    shim = mounted.instance
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: REQUESTED_BODY,
    })
    const text = await response.text()

    // Every rung that can change this body is tried: neutral head, sparse, dense.
    expect(mounted.sent.length, 'the ladder did not run on a live request').toBeGreaterThan(1)
    // And the reader is told so, by name, rather than being left to guess.
    expect(text).toContain('并已用')
  })
})
