/**
 * The wiring half of the channel-gate auto-continue: does the engine actually
 * get mounted by `apply`, read the LIVE config, and shut down with the plugin?
 *
 * The engine's own logic is pinned in `tests/channel-continue.spec.ts` against
 * injected doubles. What that suite cannot see is the three lines in `apply()`
 * that connect it to a real host — and every one of them has a failure mode that
 * is silent:
 *
 *   MOUNT     If `apply` never subscribes, the switch renders, saves and does
 *             nothing. No error anywhere; the feature simply does not exist.
 *   LIVE READ If the config is captured at mount time instead of read per
 *             failure, flipping the switch needs a plugin reload — and the card
 *             deliberately says it does not.
 *   DISPOSE   If the subscription is not registered as an effect, it survives the
 *             plugin and keeps sending 「继续」 from a disposed fiber.
 *
 * The plugin is mounted with a DIRECT `apply(ctx, config)` call, the pattern
 * `tests/issue12-region-hiding.spec.ts` established: the `config` object is then
 * shared by reference between the test and the plugin, so mutating it is exactly
 * what a Loader commit does to a volatile field.
 *
 * @module dsh-connect-workbuddy/tests/channel-continue-wiring
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as WorkBuddy from '../src/index.ts'
import type { ContinueAgent } from '../src/channel-continue.ts'

/** The config object the mounted plugin reads; reset between tests. */
let liveConfig: Record<string, unknown> = {}

let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); context = undefined; liveConfig = {} })

/**
 * A minimal `agents` service: the engine asks it for one live agent by session.
 *
 * Structural rather than the real registry because the real one lives in
 * `@deepseek-ai/dsh-agent-loop`, which this plugin does not depend on — the
 * engine resolves it through `ctx.get('agents')` for exactly that reason.
 */
class FakeAgents extends Service {
  constructor(ctx: Context, private readonly agents: Map<string, ContinueAgent>) { super(ctx, 'agents') }
  get(id: string): ContinueAgent | undefined { return this.agents.get(id) }
}

/** A CN-only machine with one signed-in account, so both providers mount. */
async function cnOnlyAuthFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-continue-wiring-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
      domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return join(dir, 'workbuddy-desktop.info')
}

/** A live-agent double that records what it was asked to send. */
function recordingAgent(): ContinueAgent & { sent: unknown[] } {
  const sent: unknown[] = []
  return { status: 'idle', followup(message: unknown) { sent.push(message) }, sent }
}

/** The failure the user pasted, in the shape the host records it. */
const CHANNEL_REJECT = {
  type: 'turn/end',
  seq: 1,
  data: {
    turn: 1,
    reason: {
      kind: 'error',
      error: {
        code: 'INVALID_REQUEST',
        message: '本轮运行失败400: {"message":"workbuddy 上游失败：被网关的渠道校验拦截'
          + '（不是账号、额度或网络问题）（http 400）（code 11128，requestId x）。…",'
          + '"type":"channel_reject","code":"channel_reject"}',
      },
    },
  },
} as const

/**
 * Mount the plugin and give the caller everything it needs to fire one event.
 *
 * Retries the emit until the listener answers: `apply` subscribes synchronously,
 * but the shims and the provider registration settle asynchronously and the whole
 * mount would otherwise be racing the assertions.
 */
async function mount(
  config: Record<string, unknown>,
  agents: Map<string, ContinueAgent>,
): Promise<{ ctx: Context, emit: (event: unknown) => Promise<void> }> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeAgents, agents)
  liveConfig = config
  WorkBuddy.apply(ctx, config as WorkBuddy.Config)
  return {
    ctx,
    emit: async (event: unknown) => {
      ;(ctx as unknown as { emit(name: string, ...args: unknown[]): void })
        .emit('session/event', { id: 's1' }, event)
      // The engine waits 300ms before sending; let its timer run.
      await new Promise(resolve => setTimeout(resolve, 450))
    },
  }
}

describe('the engine the plugin actually mounts', () => {
  it('sends 继续 after a channel-gate refusal when the switch is on', async () => {
    const authFile = await cnOnlyAuthFile()
    const agent = recordingAgent()
    const agents = new Map<string, ContinueAgent>([['s1', agent]])
    const { emit } = await mount(
      { authFile, channelRejectContinue: { enabled: true, maxConsecutive: 3, text: '继续' } },
      agents,
    )
    await expect.poll(async () => {
      await emit(CHANNEL_REJECT)
      return agent.sent.length
    }, { timeout: 5000 }).toBe(1)

    const sent = agent.sent[0] as { content: { text: string }[], source: { kind: string } }
    expect(sent.content[0]?.text).toBe('继续')
    // The engine's own kind, so the transcript does not claim the human typed it
    // and so the counter can tell the two apart.
    expect(sent.source.kind).toBe('workbuddy-continue')
  })

  it('stays silent while the switch is off — the default state', async () => {
    const authFile = await cnOnlyAuthFile()
    const agent = recordingAgent()
    const agents = new Map<string, ContinueAgent>([['s1', agent]])
    const { emit } = await mount({ authFile }, agents)
    await emit(CHANNEL_REJECT)
    expect(agent.sent).toHaveLength(0)
  })

  it('reads the switch LIVE, so no plugin reload is needed', async () => {
    // The card's copy promises "takes effect immediately"; this is that promise.
    const authFile = await cnOnlyAuthFile()
    const agent = recordingAgent()
    const agents = new Map<string, ContinueAgent>([['s1', agent]])
    const { emit } = await mount({ authFile, channelRejectContinue: { enabled: false } }, agents)
    await emit(CHANNEL_REJECT)
    expect(agent.sent).toHaveLength(0)

    // What a Loader commit does to a writable field on the shared config object.
    ;(liveConfig['channelRejectContinue'] as Record<string, unknown>)['enabled'] = true
    await emit({ ...CHANNEL_REJECT, seq: 2 })
    expect(agent.sent).toHaveLength(1)
  })

  it('stops after the configured number of consecutive sends', async () => {
    const authFile = await cnOnlyAuthFile()
    const agent = recordingAgent()
    const agents = new Map<string, ContinueAgent>([['s1', agent]])
    const { emit } = await mount(
      { authFile, channelRejectContinue: { enabled: true, maxConsecutive: 3, text: '继续' } },
      agents,
    )
    for (const seq of [1, 2, 3, 4, 5]) {
      await emit({ ...CHANNEL_REJECT, seq })
    }
    expect(agent.sent).toHaveLength(3)
  })

  it('unsubscribes when the plugin is disposed', async () => {
    // A listener left behind by a disposed fiber would keep sending 「继续」 on a
    // session the plugin no longer serves.
    const authFile = await cnOnlyAuthFile()
    const agent = recordingAgent()
    const agents = new Map<string, ContinueAgent>([['s1', agent]])
    const { ctx, emit } = await mount(
      { authFile, channelRejectContinue: { enabled: true, maxConsecutive: 3, text: '继续' } },
      agents,
    )
    await emit(CHANNEL_REJECT)
    expect(agent.sent).toHaveLength(1)

    await ctx.fiber.dispose()
    context = undefined
    await emit({ ...CHANNEL_REJECT, seq: 2 })
    expect(agent.sent).toHaveLength(1)
  })
})
