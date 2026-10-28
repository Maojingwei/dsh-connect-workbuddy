// @vitest-environment jsdom
/**
 * The card's switch for the channel-gate auto-continue, and the Host route that
 * persists it.
 *
 * Three things could go wrong here and none of them is visible in a screenshot:
 *
 * 1. An absent block renders ON. This feature spends real requests without the
 *    user typing anything, so "missing" must render as OFF — the same rule as
 *    every other opt-in capability in this plugin.
 * 2. Flipping the switch writes a bare boolean. The field is an OBJECT
 *    (`{enabled, maxConsecutive, text}`), and the cap and the text have no
 *    control on this card at all — they can only be edited in the config file.
 *    A boolean write would erase them, and the user would see the cap they set
 *    silently revert to 3.
 * 3. The Host endpoint refuses the field, in which case the switch looks flipped
 *    for one paint and then silently reverts.
 *
 * The reload caveat is asserted in the OPPOSITE direction from the neighbouring
 * upstream switches: those are sampled when the plugin mounts and need a reload,
 * while this one is read on every failure. Sharing their hint would teach the
 * user the wrong rule on the one switch where being wrong costs money.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { channelRejectContinueOf } from '../src/client/account-selection.ts'
import { en, zh } from '../src/client/locales.ts'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A signed-in usage body, trimmed to what this card needs to render. */
function usage(): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'cn One' }],
    models: [{ id: 'model-a', name: 'Model A' }],
    enabledModelIds: ['model-a'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

/** The one checkbox this feature owns, found by its class. */
function switchOf(container: HTMLElement): HTMLInputElement | undefined {
  return container.querySelector<HTMLInputElement>('.dsm-workbuddy-channel-continue-check') ?? undefined
}

function requireSwitch(container: HTMLElement): HTMLInputElement {
  const found = switchOf(container)
  if (found === undefined) throw new Error('no channel-continue switch was rendered')
  return found
}

const render = async (scopeValue: Record<string, unknown>) => {
  const calls = stubFetch((url, init) => {
    if (!url.includes('__save')) return { body: usage() }
    // Answer the way the Host does: `{ ok, value: { [field]: committed } }`.
    const posted = JSON.parse(String(init?.body ?? '{}')) as { field?: string, value?: unknown }
    return { body: { ok: true, value: posted.field === undefined ? {} : { [posted.field]: posted.value } } }
  })
  const scope = fakeScope(scopeValue)
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  return { m, scope, calls }
}

describe('the channel-gate auto-continue switch', () => {
  it('renders OFF when the block is absent', async () => {
    const { m } = await render({})
    expect(requireSwitch(m.container).checked).toBe(false)
  })

  it('renders the committed state', async () => {
    const { m } = await render({ channelRejectContinue: { enabled: true, maxConsecutive: 3, text: '继续' } })
    expect(requireSwitch(m.container).checked).toBe(true)
    // And reports the cap and the text, which have no control of their own.
    expect(m.container.textContent).toContain(t('row.channelRejectContinueLimit'))
    expect(m.container.textContent).toContain('3')
  })

  it('does not render the cap report while the switch is off', async () => {
    // A dimmed "Max consecutive sends: 3" under an OFF switch reads like a
    // setting that is already in force.
    const { m } = await render({ channelRejectContinue: { enabled: false } })
    expect(m.container.textContent).not.toContain(t('row.channelRejectContinueLimit'))
  })

  it('writes the whole block, preserving a cap and text the card cannot edit', async () => {
    const { m, scope } = await render({ channelRejectContinue: { enabled: false, maxConsecutive: 7, text: '接着做' } })
    await m.click(requireSwitch(m.container))
    await m.settle()
    expect(scope.writes.map((w: { field: string }) => w.field)).toEqual(['channelRejectContinue'])
    // A bare `true` here would have wiped both values back to their defaults.
    expect(scope.writes[0].value).toEqual({ enabled: true, maxConsecutive: 7, text: '接着做' })
  })

  it('posts the field to the Host save endpoint, so the Host keeps the truth', async () => {
    const { m, calls } = await render({})
    await m.click(requireSwitch(m.container))
    await m.settle()
    const saves = calls.filter(call => call.url.includes('__save'))
    expect(saves).toHaveLength(1)
    const save = saves[0]
    if (save === undefined) throw new Error('no __save call was made')
    const body = JSON.parse(save.init.body) as { field: string, value: unknown }
    expect(body.field).toBe('channelRejectContinue')
    expect(body.value).toEqual({ enabled: true, maxConsecutive: 3, text: '继续' })
  })

  it('explains that it spends a request and that the cap counts consecutive sends', async () => {
    // Both facts are the difference between "helpful" and "burned my quota while
    // I was not looking", and neither is inferable from the control itself. The
    // harness translator returns keys, so the COPY is read from the dictionary.
    const { m } = await render({})
    expect(m.container.textContent).toContain(t('row.channelRejectContinueHint'))
    expect(en['row.channelRejectContinueHint']).toContain('CONSECUTIVE')
    expect(en['row.channelRejectContinueHint']).toContain('spends a real request')
    expect(zh['row.channelRejectContinueHint']).toContain('连续')
    expect(zh['row.channelRejectContinueHint']).toContain('真实消耗一次请求')
  })

  it('does NOT promise a reload, unlike the group above it', async () => {
    // This switch is read from the live config on every failure. The neighbouring
    // upstream switches need a reload; carrying that rule over would be wrong —
    // and the copy says so in both languages.
    // Asserted as a POSITIVE claim in each language, not as "the word reload is
    // absent": both hints deliberately end by saying it needs no reload, and a
    // substring guard on that word would punish the honest sentence.
    expect(en['row.channelRejectContinueHint']).toContain('Takes effect immediately')
    expect(en['row.channelRejectContinueHint']).toContain('no reload')
    expect(zh['row.channelRejectContinueHint']).toContain('立即生效')
    expect(zh['row.channelRejectContinueHint']).toContain('不必重载')
  })

  it('describes the failure by its user-visible wording, in both languages', async () => {
    // The user searched for 「被网关的渠道校验拦截」; the hint must carry that exact
    // phrase, and the English copy the code number, or neither half of the
    // audience can connect the switch to the message they saw.
    expect(zh['row.channelRejectContinueHint']).toContain('被网关的渠道校验拦截')
    expect(zh['row.channelRejectContinueHint']).toContain('11128')
    expect(en['row.channelRejectContinueHint']).toContain('11128')
  })
})

/**
 * The reader, tested directly.
 *
 * It is the boundary between a hand-edited `cordis.patch.yml` block and the
 * control, so the malformed cases matter more than the happy path: a wrong read
 * shows the switch in the wrong position, or — worse — feeds the engine a cap it
 * must not use.
 */
describe('reading the block out of a settings snapshot', () => {
  it('reads the schema defaults for anything missing or malformed', () => {
    expect(channelRejectContinueOf({})).toEqual({ enabled: false, maxConsecutive: 3, text: '继续' })
    expect(channelRejectContinueOf(undefined)).toEqual({ enabled: false, maxConsecutive: 3, text: '继续' })
    // Garbage that is not an object must not fabricate an enabled switch.
    expect(channelRejectContinueOf({ channelRejectContinue: 'on' })).toEqual({ enabled: false, maxConsecutive: 3, text: '继续' })
    expect(channelRejectContinueOf({ channelRejectContinue: [1, 2] })).toEqual({ enabled: false, maxConsecutive: 3, text: '继续' })
    // Only an explicit true is ON.
    expect(channelRejectContinueOf({ channelRejectContinue: { enabled: 'yes' } }).enabled).toBe(false)
    expect(channelRejectContinueOf({ channelRejectContinue: { enabled: 1 } }).enabled).toBe(false)
    expect(channelRejectContinueOf({ channelRejectContinue: { enabled: true } }).enabled).toBe(true)
  })

  it('clamps the cap the same way the schema does', () => {
    // The reader must agree with `channelContinueSettingsOf`, or the number the
    // card REPORTS would differ from the number the engine ENFORCES.
    expect(channelRejectContinueOf({ channelRejectContinue: { maxConsecutive: 7 } }).maxConsecutive).toBe(7)
    expect(channelRejectContinueOf({ channelRejectContinue: { maxConsecutive: 0 } }).maxConsecutive).toBe(1)
    expect(channelRejectContinueOf({ channelRejectContinue: { maxConsecutive: 99 } }).maxConsecutive).toBe(10)
    expect(channelRejectContinueOf({ channelRejectContinue: { maxConsecutive: 'many' } }).maxConsecutive).toBe(3)
  })

  it('unwraps a volatile live reference', () => {
    // The settings service hands volatile fields back as `{get(): T}`; reading
    // one as a plain object would show the block as absent.
    expect(channelRejectContinueOf({
      channelRejectContinue: { get: () => ({ enabled: true, maxConsecutive: 5, text: '再试' }) },
    })).toEqual({ enabled: true, maxConsecutive: 5, text: '再试' })
  })
})
