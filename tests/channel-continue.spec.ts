/**
 * The opt-in auto-continue after the gateway's channel gate (11128).
 *
 * THE REQUEST. A user pasted this failure and asked for exactly one thing:
 *
 *   本轮运行失败400: {"message":"workbuddy 上游失败：被网关的渠道校验拦截（不是账号、
 *   额度或网络问题）（http 400）（code 11128，requestId …）。…",
 *   "type":"channel_reject","code":"channel_reject"}
 *
 * 「当我收到这样的信息的时候，自动发送继续，并且如果连续收到3次就不再发送」—
 * send 「继续」 automatically on this failure, and stop after 3 consecutive ones.
 *
 * WHY THIS FAILURE IS THE ONE THAT NEEDS IT. `channel_reject` is deliberately
 * NOT failover-worthy (`isFailoverWorthy`, `src/shim.ts`: every account sends the
 * same message openings, so swapping bills one real request per account for the
 * same refusal), and the shim has already walked its whole three-rung rescue
 * ladder inside that request. The host sees a 400 whose `code` it does not
 * recognise, so it does not retry either — the turn simply ends. A NEW turn is a
 * rebuilt request, which is the manual remedy `docs/PINNED-11128-RETRY.md`
 * already recommends. This feature automates that one act.
 *
 * WHAT THESE CASES PIN. The cap is the user's explicit requirement, so the
 * counter's semantics get the most attention: it must increment per send, stop at
 * the limit instead of looping, and reset on a successful turn OR on a real human
 * message — but NOT on the plugin's own message, which would silently defeat the
 * cap. Two directions are both failures worth a test: sending when it should not
 * (spends the user's quota) and not sending when it should (the feature looks
 * broken). The negative side also covers the failures this must never react to —
 * quota, rate limit, transport — because reacting to those spends a request to be
 * told the same thing again.
 *
 * @module dsh-connect-workbuddy/tests/channel-continue
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  channelContinueSettingsOf,
  createChannelContinue,
  DEFAULT_CONTINUE_TEXT,
  DEFAULT_MAX_CONSECUTIVE,
  installChannelContinue,
  isChannelRejectFailure,
  type ChannelContinueHost,
  type ContinueAgent,
} from '../src/channel-continue.ts'

/**
 * The user's verbatim failure message.
 *
 * Kept byte-close to the paste on purpose: the classification reads this text,
 * so a copy that drifted would test a sentence no user ever sees. The wrapper of
 * `本轮运行失败400: ` is the HOST's frame around the plugin's own message, and it
 * is part of what arrives — the reason the check cannot rely on the plugin's JSON
 * shape surviving unmodified.
 */
const REPORTED_MESSAGE =
  '本轮运行失败400: {"message":"workbuddy 上游失败：被网关的渠道校验拦截（不是账号、额度或网络问题）'
  + '（http 400）（code 11128，requestId 31a97b9f-aa3e-4b6c-9d9f-cefd932004f6）。…",'
  + '"type":"channel_reject","code":"channel_reject"}'

/** One `turn/end` event carrying an error reason. */
function turnEndError(seq: number, failure: unknown): Record<string, unknown> {
  return {
    type: 'turn/end',
    seq,
    data: { turn: 1, reason: { kind: 'error', error: failure } },
  }
}

const session = (id: string, origin?: string): Record<string, unknown> => ({
  id,
  ...(origin === undefined ? {} : { header: { origin } }),
})

/** A live-agent double that records what it was asked to send. */
function fakeAgent(overrides: Partial<ContinueAgent> & { status?: string } = {}): ContinueAgent & {
  sent: unknown[]
} {
  const sent: unknown[] = []
  return {
    status: overrides.status ?? 'idle',
    ...(overrides.session === undefined ? {} : { session: overrides.session }),
    followup(message: unknown) { sent.push(message) },
    sent,
  }
}

/** Build an engine over a mutable config + agent map. */
function build(initial: { enabled?: boolean, maxConsecutive?: number, text?: string } = {}): {
  engine: ReturnType<typeof createChannelContinue>
  logs: string[]
  agents: Map<string, ContinueAgent>
  config: { enabled: boolean, maxConsecutive: number, text: string }
  setConfig: (next: Partial<{ enabled: boolean, maxConsecutive: number, text: string }>) => void
} {
  const logs: string[] = []
  const agents = new Map<string, ContinueAgent>()
  const config = channelContinueSettingsOf(
    initial.enabled ?? true,
    initial.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE,
    initial.text ?? DEFAULT_CONTINUE_TEXT,
  )
  const host: ChannelContinueHost = {
    getConfig: () => config,
    getAgent: id => agents.get(id),
    log: message => { logs.push(message) },
  }
  return {
    engine: createChannelContinue(host),
    logs,
    agents,
    config,
    setConfig(next) {
      Object.assign(config, next)
    },
  }
}

/** Run the pending 300ms send timer. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('recognising the failure this feature exists for', () => {
  it('accepts the message the user actually pasted', () => {
    // The host's `LlmFailure` re-classifies a 400 from its TEXT
    // (`classifyPiAiError` → INVALID_REQUEST), so `code` alone is not enough.
    expect(isChannelRejectFailure({ code: 'INVALID_REQUEST', message: REPORTED_MESSAGE })).toBe(true)
  })

  it('accepts the plugin own kind, whichever field carries it', () => {
    expect(isChannelRejectFailure({ code: 'channel_reject', message: 'anything' })).toBe(true)
    expect(isChannelRejectFailure({ code: 'X', message: '{"type":"channel_reject"}' })).toBe(true)
    // And the Chinese line the shim writes, in case the response body was cut.
    expect(isChannelRejectFailure({ code: 'X', message: '被网关的渠道校验拦截（不是账号、额度或网络问题）' })).toBe(true)
  })

  it('refuses every failure that a new turn cannot help', () => {
    // Each of these has its own remedy; resending 「继续」 would buy the same
    // answer for a real request. Quota/limit/transport are exactly the codes
    // `dsh-purge` excludes too (`NO_CONTINUE_CODES`), independently arrived at.
    const notChannel = [
      { code: 'quota_exceeded', message: 'workbuddy 上游失败：被限流（http 429）：池中已无可用账号（code 6004）' },
      { code: 'RATE_LIMIT', message: '429: usage exceeds frequency limit' },
      { code: 'TRANSPORT', message: 'stream ended before completion' },
      { code: 'AUTH', message: '401 unauthorized' },
      { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long' },
      { code: 'EMPTY_RESPONSE', message: 'model returned a completed response with no content' },
    ]
    for (const failure of notChannel) expect(isChannelRejectFailure(failure), failure.code).toBe(false)
    // Garbage in, no crash and no match.
    expect(isChannelRejectFailure(undefined)).toBe(false)
    expect(isChannelRejectFailure(null)).toBe(false)
    expect(isChannelRejectFailure('channel_reject')).toBe(false)
    expect(isChannelRejectFailure({ code: 'channel_reject'.toUpperCase() })).toBe(false)
    expect(isChannelRejectFailure({ message: 42 })).toBe(false)
  })
})

describe('the settings the schema hands over', () => {
  it('reads only an explicit true as ON', () => {
    // This switch spends real requests, so a missing or malformed value must be
    // OFF — the same rule as every other opt-in capability in this plugin.
    for (const value of [undefined, null, false, 'true', 1, {}]) {
      expect(channelContinueSettingsOf(value, 3, '继续').enabled, String(value)).toBe(false)
    }
    expect(channelContinueSettingsOf(true, 3, '继续').enabled).toBe(true)
  })

  it('defaults the cap to 1 and clamps whatever it is given', () => {
    expect(channelContinueSettingsOf(true, undefined, undefined).maxConsecutive).toBe(1)
    expect(channelContinueSettingsOf(true, 5, undefined).maxConsecutive).toBe(5)
    // 0 would make the feature a silent no-op, which is worse than off.
    expect(channelContinueSettingsOf(true, 0, undefined).maxConsecutive).toBe(1)
    expect(channelContinueSettingsOf(true, -4, undefined).maxConsecutive).toBe(1)
    // A cap that never stops is a loop; the schema ceiling is 10.
    expect(channelContinueSettingsOf(true, 999, undefined).maxConsecutive).toBe(10)
    expect(channelContinueSettingsOf(true, 2.7, undefined).maxConsecutive).toBe(2)
    expect(channelContinueSettingsOf(true, Number.NaN, undefined).maxConsecutive).toBe(1)
  })

  it('falls back to 「继续」 for a blank text instead of sending an empty turn', () => {
    expect(channelContinueSettingsOf(true, 3, '  ').text).toBe('继续')
    expect(channelContinueSettingsOf(true, 3, ' 继续 ').text).toBe('继续')
    expect(channelContinueSettingsOf(true, 3, '再试一次').text).toBe('再试一次')
    expect(channelContinueSettingsOf(true, 3, 7).text).toBe('继续')
  })
})

describe('the consecutive cap — the user explicit requirement', () => {
  it('sends 继续 exactly three times when the user sets the cap to 3, then stops', async () => {
    const { engine, agents } = build({ maxConsecutive: 3 })
    const agent = fakeAgent()
    agents.set('s1', agent)

    for (let round = 1; round <= 6; round += 1) {
      engine.onSessionEvent(session('s1'), turnEndError(round, { code: 'channel_reject', message: REPORTED_MESSAGE }))
      await flush()
      expect(agent.sent, `after failure ${String(round)}`).toHaveLength(Math.min(round, 3))
    }
    // Three sends, not six: the cap held.
    expect(agent.sent).toHaveLength(3)
  })

  it('reports the count it actually reached, never more than the cap', async () => {
    // The counter is the only diagnostic this feature exposes, so it must not
    // claim "4 of 3" just to remember that the cap was already announced.
    const { engine, agents } = build({ maxConsecutive: 2 })
    agents.set('s1', fakeAgent())
    for (const seq of [1, 2, 3, 4]) {
      engine.onSessionEvent(session('s1'), turnEndError(seq, { code: 'channel_reject' }))
      await flush()
    }
    expect(engine.stateOf('s1')?.consecutive).toBe(2)
  })

  it('resets the count after one successful turn', async () => {
    const { engine, agents } = build({ maxConsecutive: 3 })
    const agent = fakeAgent()
    agents.set('s1', agent)

    for (const seq of [1, 2, 3]) {
      engine.onSessionEvent(session('s1'), turnEndError(seq, { code: 'channel_reject' }))
      await flush()
    }
    expect(agent.sent).toHaveLength(3)

    // One completed turn proves the channel gate let something through.
    engine.onSessionEvent(session('s1'), { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } })
    engine.onSessionEvent(session('s1'), turnEndError(5, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(4)
  })

  it('resets on a message the user typed, but NOT on the plugin own message', async () => {
    const { engine, agents } = build({ maxConsecutive: 1 })
    const agent = fakeAgent()
    agents.set('s1', agent)

    // The plugin's own send must not clear the counter — if it did, the cap
    // could never be reached even once.
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(1)
    engine.onSessionEvent(session('s1'), {
      type: 'user/message',
      seq: 2,
      data: { role: 'user', content: [], source: { kind: 'workbuddy-continue', form: 'notice', summary: 'x' } },
    })
    engine.onSessionEvent(session('s1'), turnEndError(3, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent, 'the plugin own echo must not reset the cap').toHaveLength(1)

    // A real human message does reset it.
    engine.onSessionEvent(session('s1'), {
      type: 'user/message',
      seq: 4,
      data: { role: 'user', content: [], source: { kind: 'user' } },
    })
    engine.onSessionEvent(session('s1'), turnEndError(5, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(2)
  })

  it('counts per session, so one stuck conversation cannot starve another', async () => {
    const { engine, agents } = build({ maxConsecutive: 3 })
    const a = fakeAgent()
    const b = fakeAgent()
    agents.set('a', a)
    agents.set('b', b)

    for (const seq of [1, 2, 3]) {
      engine.onSessionEvent(session('a'), turnEndError(seq, { code: 'channel_reject' }))
      await flush()
    }
    engine.onSessionEvent(session('b'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(a.sent).toHaveLength(3)
    expect(b.sent).toHaveLength(1)
  })
})

describe('the guards that keep it from making things worse', () => {
  it('does nothing at all while the switch is off', async () => {
    const { engine, agents, logs } = build({ enabled: false })
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject', message: REPORTED_MESSAGE }))
    await flush()
    expect(agent.sent).toHaveLength(0)
    // Silent in the log too: this is the default state, not an event.
    expect(logs).toHaveLength(0)
  })

  it('reads the switch live, so flipping it on needs no reload', async () => {
    const { engine, agents, setConfig } = build({ enabled: false })
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(0)

    setConfig({ enabled: true })
    engine.onSessionEvent(session('s1'), turnEndError(2, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(1)
  })

  it('never touches a subagent session', async () => {
    // A subagent's turns are driven by its parent; injecting a user turn here
    // would corrupt the execution tree. Detected from the session header AND
    // from the live agent, because either can be the only one that knows.
    const { engine, agents } = build()
    const fromHeader = fakeAgent()
    const fromAgent = fakeAgent({ session: { header: { origin: 'subagent' } } })
    agents.set('h', fromHeader)
    agents.set('a', fromAgent)

    engine.onSessionEvent(session('h', 'subagent'), turnEndError(1, { code: 'channel_reject' }))
    engine.onSessionEvent(session('a'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(fromHeader.sent).toHaveLength(0)
    expect(fromAgent.sent).toHaveLength(0)
  })

  it('refuses to wake a session that is already running', async () => {
    // A failure followed by a host-side retry or a compaction would otherwise
    // get a second, competing intent queued behind it.
    const { engine, agents, logs } = build()
    const agent = fakeAgent({ status: 'running' })
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(0)
    expect(logs.join('\n')).toContain('回合已经在跑')
  })

  it('refuses when someone already queued something in the inbox', async () => {
    // The user is very likely typing right now; a 「继续」 behind their question
    // would make the model answer the wrong thing first.
    const { engine, agents, logs } = build()
    const busy = fakeAgent()
    Object.defineProperty(busy, 'inbox', { value: { hasPending: () => true } })
    agents.set('s1', busy)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(busy.sent).toHaveLength(0)
    expect(logs.join('\n')).toContain('收件箱里已有排队内容')
  })

  it('drops a scheduled send when the host starts a new turn first', async () => {
    const { engine, agents } = build()
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    // The user hits enter (or the host retries) inside the grace window.
    engine.onSessionEvent(session('s1'), { type: 'turn/start', seq: 2, data: { turn: 2 } })
    await flush()
    expect(agent.sent).toHaveLength(0)
  })

  it('cancels a pending send on a completed turn', async () => {
    const { engine, agents } = build()
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    engine.onSessionEvent(session('s1'), { type: 'turn/end', seq: 2, data: { turn: 2, reason: { kind: 'completed' } } })
    await flush()
    expect(agent.sent).toHaveLength(0)
  })

  it('treats a user abort as intervention and stops', async () => {
    const { engine, agents } = build({ maxConsecutive: 1 })
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(1)
    engine.onSessionEvent(session('s1'), {
      type: 'turn/end',
      seq: 2,
      data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    engine.onSessionEvent(session('s1'), turnEndError(3, { code: 'channel_reject' }))
    await flush()
    // Reset by the abort, so the next failure gets a send again.
    expect(agent.sent).toHaveLength(2)
  })

  it('does not send twice for the same turn/end seq', async () => {
    // The firehose can replay; a replayed event must not spend a second request.
    const { engine, agents } = build()
    const agent = fakeAgent()
    agents.set('s1', agent)
    const event = turnEndError(7, { code: 'channel_reject' })
    engine.onSessionEvent(session('s1'), event)
    await flush()
    engine.onSessionEvent(session('s1'), event)
    await flush()
    expect(agent.sent).toHaveLength(1)
  })

  it('sends one message per failure even while a send is pending', async () => {
    const { engine, agents } = build()
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    engine.onSessionEvent(session('s1'), turnEndError(2, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(1)
  })

  it('logs a named reason instead of failing silently when the agent is gone', async () => {
    const { engine, logs } = build()
    engine.onSessionEvent(session('gone'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    // No live agent: nothing to send, and the refusal is sayable.
    expect(logs.join('\n')).toContain('没有 live agent')
  })

  it('survives a followup that throws', async () => {
    const { engine, agents, logs } = build()
    const thrower: ContinueAgent = {
      status: 'idle',
      followup() { throw new Error('driver gone') },
    }
    agents.set('s1', thrower)
    expect(() => {
      engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    }).not.toThrow()
    await flush()
    expect(logs.join('\n')).toContain('driver gone')
  })
})

describe('the message it sends', () => {
  it('carries the configured text and its own source kind, never kind user', async () => {
    // `kind: 'user'` would (a) render as a bubble the human never typed and
    // (b) reset this very counter, defeating the cap.
    const { engine, agents } = build({ text: '继续' })
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()

    const sent = agent.sent[0] as { role: string, content: { type: string, text: string }[], source: { kind: string } }
    expect(sent.role).toBe('user')
    expect(sent.content).toEqual([{ type: 'text', text: '继续' }])
    expect(sent.source.kind).toBe('workbuddy-continue')
    expect(sent.source.kind).not.toBe('user')
  })
})

describe('teardown and memory', () => {
  it('dispose cancels a pending send and forgets every session', async () => {
    const { engine, agents } = build()
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    expect(engine.stateOf('s1')?.pending).toBe(true)
    engine.dispose()
    await flush()
    expect(agent.sent).toHaveLength(0)
    expect(engine.stateOf('s1')).toBeUndefined()
  })

  it('ignores events after disposal', async () => {
    const { engine, agents } = build()
    const agent = fakeAgent()
    agents.set('s1', agent)
    engine.dispose()
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(agent.sent).toHaveLength(0)
  })

  it('caps how many sessions it remembers', async () => {
    // A long-lived host would otherwise keep one slot per conversation forever.
    const { engine } = build()
    for (let index = 0; index < 400; index += 1) {
      engine.onSessionEvent(session(`s${String(index)}`), {
        type: 'turn/end',
        seq: 1,
        data: { turn: 1, reason: { kind: 'completed' } },
      })
    }
    // The newest sessions are still tracked; the oldest were evicted.
    expect(engine.stateOf('s399')).toBeDefined()
    expect(engine.stateOf('s0')).toBeUndefined()
  })

  it('exposes its counter for diagnostics without exposing the map', async () => {
    const { engine, agents } = build()
    agents.set('s1', fakeAgent())
    engine.onSessionEvent(session('s1'), turnEndError(1, { code: 'channel_reject' }))
    await flush()
    expect(engine.stateOf('s1')).toEqual({ consecutive: 1, pending: false })
    expect(engine.stateOf('unknown')).toBeUndefined()
  })
})

describe('mounting on a host whose event bus is not what we expect', () => {
  it('leaves the feature INERT rather than failing the plugin mount', () => {
    // A host that does not emit `session/event` (or a fiber that refuses the
    // subscription) must not take the whole plugin down for an optional
    // convenience. It must also say WHY, or a user who switched it on and saw
    // nothing happen has no way to learn the reason.
    const logs: string[] = []
    const dispose = installChannelContinue({
      getConfig: () => channelContinueSettingsOf(true, 3, '继续'),
      getAgent: () => undefined,
      log: message => { logs.push(message) },
      onSessionEvent: () => { throw new Error('no such event on this host') },
    })
    expect(logs.join('\n')).toContain('自动续发不可用')
    expect(logs.join('\n')).toContain('no such event on this host')
    // And the returned disposer is safe to call, so `ctx.effect` cannot throw.
    expect(() => { dispose() }).not.toThrow()
  })

  it('unsubscribes through the disposer the host handed back', () => {
    let off = 0
    const dispose = installChannelContinue({
      getConfig: () => channelContinueSettingsOf(false, 3, '继续'),
      getAgent: () => undefined,
      log: () => {},
      onSessionEvent: () => () => { off += 1 },
    })
    dispose()
    expect(off).toBe(1)
    // Calling it twice must not double-unsubscribe or throw: Cordis effects can
    // run a disposer more than once during a reload.
    expect(() => { dispose() }).not.toThrow()
    expect(off).toBe(2)
  })
})
