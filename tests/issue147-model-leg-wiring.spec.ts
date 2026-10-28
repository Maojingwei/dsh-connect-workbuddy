/**
 * THE WIRING, not just the predicate.
 *
 * `foreignThinkingOf` taking a third argument proves nothing about production
 * unless `withLegacyContext` actually PASSES it. Verified by mutation: replacing
 * `prepare(context, model.id)` with `prepare(context)` in all four entry points
 * leaves the whole suite green without this file — the pure-function tests call
 * the predicate themselves, so nothing notices the wrapper dropped the id.
 * That is the same shape of hole `tests/adapter.spec.ts` exists to close for
 * issue #24.
 *
 * Both the LEGACY and MODERN branches are covered, because they are separate
 * return statements and a fix applied to one is a fix applied to neither.
 *
 * @module dsh-connect-workbuddy/tests/issue147-model-leg-wiring
 */

import { describe, expect, it, vi } from 'vitest'
import { HOST_FOREIGN_API, WORKBUDDY_MODEL_IDENTITY, WORKBUDDY_PROVIDER } from '../src/adapter.ts'

/** Contexts the api actually received; the assertions are about what it was HANDED. */
const received: unknown[] = []

vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({
    stream: (_model: unknown, context: unknown) => { received.push(context); return emptyStream() },
    streamSimple: (_model: unknown, context: unknown) => { received.push(context); return emptyStream() },
  }),
}))

function emptyStream(): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: async function* () { /* no events */ } }
}

/** A turn THIS plugin produced, recorded under a DIFFERENT model id (the model leg). */
function previousModelTurn(): Record<string, unknown> {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: WORKBUDDY_MODEL_IDENTITY,
    model: 'hy3',
    content: [
      { type: 'thinking', thinking: 'MY-OWN-PRIVATE-NOTES' },
      { type: 'text', text: 'the answer' },
    ],
    usage: { input: 1, output: 1 },
    stopReason: 'stop',
    timestamp: 1,
  }
}

/**
 * A turn from ANOTHER provider, exactly as the host rebuilds it after a switch:
 * `api: dsh-foreign`, the other route id, and an unsigned thinking block.
 *
 * This is the surface issue #163's provider-switch scene exposed: pi-ai would
 * flatten the thinking block into visible assistant prose, which the WorkBuddy
 * gateway then refuses with 11128.
 */
function crossProviderTurn(): Record<string, unknown> {
  return {
    role: 'assistant',
    api: HOST_FOREIGN_API,
    provider: 'dsh-opencode-go',
    model: 'deepseek-v4.1-flash',
    content: [
      { type: 'thinking', thinking: 'FOREIGN-PRIVATE-NOTES' },
      { type: 'text', text: 'the foreign answer' },
    ],
    usage: { input: 1, output: 1 },
    stopReason: 'stop',
    timestamp: 1,
  }
}

/** Block types of the assistant turns the api was handed. */
function assistantBlockTypes(context: unknown): string[][] {
  const messages = (context as { messages: Array<{ role: string, content: Array<{ type: string }> }> }).messages
  return messages
    .filter(message => message.role === 'assistant')
    .map(message => message.content.map(block => block.type))
}

async function streamThrough(
  generation: 'legacy' | 'modern',
  entry: 'stream' | 'streamSimple',
  options: { enabled?: boolean, requestModelId?: string, message?: Record<string, unknown> } = {},
): Promise<{ seen: unknown, reported: unknown[] }> {
  received.length = 0
  const reported: unknown[] = []
  const { createWorkBuddyAdapter } = await import('../src/adapter.ts')
  const { WorkBuddyCatalog } = await import('../src/catalog.ts')

  const { adapter } = createWorkBuddyAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
    store: {} as never,
    catalog: new WorkBuddyCatalog(),
    piAiGeneration: generation,
    dropForeignThinking: () => options.enabled ?? true,
    onForeignThinking: blocks => { reported.push(...blocks) },
  })
  const profile = (adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, { piProvider: Record<string, (m: unknown, c: unknown, o: unknown) => unknown> }> }
  }).config.profiles().get(WORKBUDDY_PROVIDER)
  expect(profile).toBeDefined()

  // The request names a DIFFERENT model from the one the turn was recorded
  // under. That is the whole point: provider and api still match, so only the
  // model leg can see this.
  const model = {
    id: options.requestModelId ?? 'deepseek-v4.1-flash',
    api: 'openai-completions',
    provider: WORKBUDDY_MODEL_IDENTITY,
    baseUrl: 'http://127.0.0.1:1/v1',
  }
  profile?.piProvider[entry]?.(
    model,
    {
      messages: [
        { role: 'user', content: 'continue', timestamp: 0 },
        options.message ?? previousModelTurn(),
      ],
    },
    { apiKey: 'k' },
  )

  expect(received).toHaveLength(1)
  return { seen: received[0], reported }
}

describe.each(['legacy', 'modern'] as const)('the %s branch passes the request model id', generation => {
  it.each(['stream', 'streamSimple'] as const)('%s drops the previous model\'s thinking', async entry => {
    const { seen, reported } = await streamThrough(generation, entry)
    // The api was handed the turn WITHOUT its thinking block: pi-ai cannot
    // flatten what is no longer there, so no prose can be manufactured.
    expect(assistantBlockTypes(seen)).toEqual([['text']])
    // And the diagnostic fired, so the card can name the condition.
    expect(reported).toHaveLength(1)
  })

  it.each(['stream', 'streamSimple'] as const)('%s keeps the thinking when the request names the SAME model', async entry => {
    // The control for the assertion above: without it, a `prepare` that dropped
    // EVERY thinking block unconditionally would pass just as well. Same turn,
    // same switch, but the request now names the model it was recorded under —
    // which is `isSameModel` holding, so pi-ai keeps the block and so must we.
    const { seen, reported } = await streamThrough(generation, entry, { requestModelId: 'hy3' })
    expect(assistantBlockTypes(seen)).toEqual([['thinking', 'text']])
    expect(reported).toHaveLength(0)
  })

  it.each(['stream', 'streamSimple'] as const)('%s is a no-op when the switch is off', async entry => {
    // The off path must stay byte-for-byte 5.12.0: a caller that never opted in
    // cannot have its request rewritten by the new wiring.
    const { seen, reported } = await streamThrough(generation, entry, { enabled: false })
    expect(assistantBlockTypes(seen)).toEqual([['thinking', 'text']])
    expect(reported).toHaveLength(0)
  })

  it.each(['stream', 'streamSimple'] as const)('%s drops a cross-provider turn even with the switch off', async entry => {
    // Issue #163's provider-switch scene. A `dsh-foreign` turn's thinking block
    // has no signature and can never be replayed; pi-ai would flatten it to
    // assistant prose, which the WorkBuddy gateway refuses with 11128. This is
    // a correctness repair, so it must not wait for the same-route opt-in.
    const { seen, reported } = await streamThrough(generation, entry, {
      enabled: false,
      message: crossProviderTurn(),
    })
    expect(assistantBlockTypes(seen)).toEqual([['text']])
    expect(reported).toHaveLength(1)
  })
})
