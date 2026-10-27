/**
 * Issue #155, second report, driven against the ACTUALLY MOUNTED plugin.
 *
 * WHY THIS FILE EXISTS BESIDE `issue155-account-removal.spec.ts`. That one tests
 * the helpers against doubles I wrote; this one calls the real pool route on a
 * real `apply()` and asserts the real config object. `tests/pool-e2e.spec.ts`
 * exists for the same reason and says it better than I can: unit tests that
 * inject doubles for the Host's own behaviour verify code against MY idea of the
 * Host, not against the Host — and every defect it lists was invisible to those
 * tests for exactly that reason.
 *
 * THE REPORT, IN THE REPORTER'S OWN WORDS.
 *
 *   删了一个账号就这样了 —— CN 整块变「未登录」，提示「已保存的账号在本机已不存在」，
 *   但上方账号列表一条都不渲染
 *   cordis.patch.yml 里：accounts: cn: cd****38 ← 本机已不存在的 id
 *
 * The chain the fix must break, in order:
 *
 *   1. `removeAccount` forgets the selection IN MEMORY (`src/auth.ts`) — so the
 *      region still works for the rest of this process;
 *   2. the settings document STILL names the dead id;
 *   3. the next `applySelection` re-reads it and re-pins it;
 *   4. `current()` finds no such account → `resolve()` throws → the usage route
 *      answers `signed-out` + `selectionLost`;
 *   5. the card's advice in that state points at a list it does not render.
 *
 * Steps 1 and 3 are the seam the bug hides in: everything looks fine inside the
 * session, so the removal reports success and the dead end arrives later, at the
 * next restart — which is why the two were never connected. This file therefore
 * asserts the WHOLE chain: after a removal, an explicit re-apply (the 0.1.7 write
 * announcement, i.e. what a restart or any settings save performs) must leave the
 * region signed IN. That claim is unfalsifiable by a memory-only forget, which is
 * exactly why it is the one worth spending a mounted-plugin file on.
 *
 * @module dsh-connect-workbuddy/tests/issue155-removal-e2e
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as WorkBuddy from '../src/index.ts'
import { WORKBUDDY_POOL_PATH, WORKBUDDY_USAGE_PATH } from '../src/status-paths.ts'

/** An id in the shape the route's `isVaultAccountId` accepts (24 hex), absent locally. */
const DEAD = 'cd0f1a2b3c4d5e6f7a8b9c0d'
/** The sibling region's pin, which must survive every write here. */
const SIBLING = 'aa11bb22cc33dd44ee55ff66'

let context: Context | undefined
/** The config object the mounted plugin reads BY REFERENCE, as on 0.1.7. */
let liveConfig: Record<string, unknown> = {}
let routes: { path: string, handler: (req: never, res: never) => Promise<void> | void }[] = []
/** Fields `mutate` wrote, in order. A removal that must not write asserts this empty. */
let mutations: string[] = []
/**
 * Whether the settings service accepts a write.
 *
 * Configured through the service's OWN method rather than by reassigning
 * `context.settings.mutate` in a test: the plugin resolves the service through
 * `ctx.get('settings')`, which may hand back a proxy, so a property assignment
 * on the context's view can leave the plugin's view untouched — and the test
 * would then assert that a write failed to happen because it never could.
 */
let writable = true

/** A fake webServer that records routes instead of serving them. */
const FakeWebServer = {
  name: 'webServer',
  inject: [] as const,
  apply(ctx: Context) {
    ctx.provide('webServer', {
      register: (entry: typeof routes[number]) => {
        routes.push(entry)
        return () => {}
      },
    })
  },
}

/**
 * The 0.1.7-shaped settings service: `describe()` answers the LIVE config object,
 * `mutate` commits into it IN PLACE, then announces the write.
 *
 * By-reference is the whole point. The plugin's `current()` reads this exact
 * object and `hostSettings()` is fetched at the moment of the write, so a service
 * answering a clone would let a stale read pass as a live one — and the
 * sibling-preservation assertions below would then test nothing but my own
 * helper. In-place commit + announcement is what the real Loader does for a
 * volatile-only write (see `tests/settings-integration.spec.ts`).
 *
 * `set` on a one-segment path REPLACES that field, which is the contract
 * `writeRegionCatalog` and the card's save endpoint rely on; merging here would
 * hide a writer that dropped a sibling key.
 */
class LiveConfigSettings extends Service {
  readonly writable = true
  constructor(ctx: Context) {
    super(ctx, 'settings')
  }
  configure(): () => void {
    return () => {}
  }
  describe() {
    return [{
      ns: WorkBuddy.WORKBUDDY_SETTINGS_NS,
      revision: 0,
      applies: 'live',
      value: liveConfig,
      base: structuredClone(liveConfig),
      user: structuredClone(liveConfig),
    }]
  }
  async mutate(_ns: string, ops: readonly { op: 'set', path: readonly string[], value: unknown }[]): Promise<void> {
    if (!writable) throw new Error('profile is not writable')
    for (const op of ops) {
      liveConfig[op.path[0] as string] = structuredClone(op.value)
      mutations.push(op.path[0] as string)
    }
    // The announcement the plugin re-arms on: `applySelection(current())`, i.e.
    // the same re-read a restart performs. Emitting it is what makes step 3 of
    // the chain above REAL instead of asserted by reading a file.
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
  }
  async get(): Promise<unknown> {
    return liveConfig
  }
}

/** One CN sign-in, so the region has a real account to serve after a clear. */
async function writeAuthFixture(root: string): Promise<string> {
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'workbuddy-desktop.info')
  await writeFile(path, JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
      domain: 'www.codebuddy.cn',
      expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return join(dir, 'workbuddy-desktop.info')
}

async function mount(config: Record<string, unknown>): Promise<Context> {
  routes = []
  mutations = []
  writable = true
  liveConfig = config
  const ctx = new Context()
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(LiveConfigSettings)
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  await new Promise(resolve => setTimeout(resolve, 0))
  context = ctx
  return ctx
}

/**
 * The real id of the fixture sign-in, discovered through the plugin itself.
 *
 * Same reasoning as `discoverAccountIds` in `tests/pool-e2e.spec.ts`: a test that
 * needs a RESOLVABLE account must not invent its id, or it asserts a shape the
 * Host never produces — `workbuddyAccountId` is a sha256 slice of the document.
 */
async function discoverCnAccountId(authFile: string): Promise<string> {
  await mount({ authFile, regions: { cn: { enabled: true } } })
  const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast` })
  const id = ((body['accounts'] ?? []) as { id: string }[])[0]?.id
  await context?.fiber.dispose()
  context = undefined
  if (id === undefined) throw new Error('fixture produced no account')
  return id
}

function response(): {
  res: { writeHead: (s: number) => void, end: (b?: string) => void }
  status: () => number
  body: () => Record<string, unknown>
} {
  let statusCode = 0
  let payload = ''
  return {
    res: {
      writeHead: (s: number) => { statusCode = s },
      end: (b?: string) => { payload = b ?? '' },
    },
    status: () => statusCode,
    body: () => JSON.parse(payload || '{}') as Record<string, unknown>,
  }
}

async function call(
  path: string,
  init: { method?: string, url?: string } = {},
): Promise<{ status: number, body: Record<string, unknown> }> {
  const route = routes.find(entry => entry.path === path)
  if (route === undefined) throw new Error(`route not mounted: ${path}`)
  const { res, status, body } = response()
  await route.handler(
    // `host` is required, not decoration: every real request carries one and the
    // routes refuse a missing Host (DNS-rebinding guard).
    { method: init.method ?? 'GET', url: init.url ?? path, headers: { host: '127.0.0.1:62283' } } as never,
    res as never,
  )
  return { status: status(), body: body() }
}

/** The removal the card's row button performs. */
const removeCnAccount = (accountId: string) => call(WORKBUDDY_POOL_PATH, {
  method: 'POST',
  url: `${WORKBUDDY_POOL_PATH}?region=cn&action=remove&accountId=${accountId}`,
})

/**
 * The region's state after any number of re-applies.
 *
 * `detail=fast` deliberately: the full document fetches credits per account, and
 * these tests assert which ACCOUNT serves and whether the region is signed in —
 * not figures that would need a stubbed billing endpoint.
 */
const cnRegionState = async (): Promise<Record<string, unknown>> =>
  (await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast` })).body

/** The persisted selections, as the settings document holds them. */
const persistedAccounts = (): Record<string, unknown> => liveConfig['accounts'] as Record<string, unknown>
/** Only the writes this file is about; boot-time repairs write other fields. */
const accountWrites = (): string[] => mutations.filter(field => field === 'accounts')

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-issue155-'))
})
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
})

describe('removing the pinned account, end to end (issue #155)', () => {
  it('clears the persisted pin so a re-apply does not return the region to signed-out', async () => {
    const authFile = await writeAuthFixture(root)
    // The reporter's state: CN pinned to an id, which is the account they are
    // about to remove. Nothing local matches that id, so before the removal the
    // region is ALREADY in the dead-end state they described.
    await mount({ authFile, accounts: { cn: DEAD, global: SIBLING }, regions: { cn: { enabled: true } } })
    await expect.poll(async () => (await cnRegionState())['status']).toBe('signed-out')
    expect((await cnRegionState())['selectionLost']).toBe(true)

    await expect(removeCnAccount(DEAD)).resolves.toMatchObject({ status: 200 })

    // The pin is GONE, replaced by the follow-the-app sentinel — never a deleted
    // key, which would fall through to the legacy flat `accountId`.
    expect(persistedAccounts()).toEqual({ cn: '', global: SIBLING })

    // THE CLAIM THE OLD CODE COULD NOT MAKE. Re-read the config the way a restart
    // does: without the clear above, this is exactly where the dead id came back,
    // and the store's in-memory forget would have looked like a fix.
    await expect.poll(async () => (await cnRegionState())['status']).toBe('signed-in')
    expect((await cnRegionState())['selectionLost']).toBeUndefined()
  })

  it('leaves the sibling region pin alone', async () => {
    // `accounts` is one flat two-key map that BOTH regions write, so a whole-field
    // write built from one caller's view would drop the other's pin — a silent
    // account switch for a user who never touched that tab, and 「换账号等于换人
    // 计费」 is why this is asserted separately rather than as a `toMatchObject`.
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, accounts: { cn: DEAD, global: SIBLING }, regions: { cn: { enabled: true } } })
    await removeCnAccount(DEAD)
    expect(persistedAccounts()['global']).toBe(SIBLING)
  })

  it('writes NOTHING when the removed account is not the one this region pins', async () => {
    // The other side of the same rule. Removing an unused account must not move
    // anybody off the account they chose: `current()` refuses the same fallback in
    // memory, so a removal must not do through the settings file what the store
    // will not do at request time.
    const authFile = await writeAuthFixture(root)
    const pinned = await discoverCnAccountId(authFile)
    await mount({ authFile, accounts: { cn: pinned, global: SIBLING }, regions: { cn: { enabled: true } } })
    await expect.poll(async () => (await cnRegionState())['status']).toBe('signed-in')

    await expect(removeCnAccount(DEAD)).resolves.toMatchObject({ status: 200 })

    expect(accountWrites()).toEqual([])
    expect(persistedAccounts()).toEqual({ cn: pinned, global: SIBLING })
    const state = await cnRegionState()
    expect(state['status']).toBe('signed-in')
    // Still serving the SAME account it was before the removal.
    expect(state['accountId']).toBe(pinned)
  })

  it('leaves a region that was already following the app un-written', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, accounts: { cn: '', global: SIBLING }, regions: { cn: { enabled: true } } })
    await expect(removeCnAccount(DEAD)).resolves.toMatchObject({ status: 200 })
    expect(accountWrites()).toEqual([])
    await expect.poll(async () => (await cnRegionState())['status']).toBe('signed-in')
  })

  it('still reports a successful removal when the settings write fails', async () => {
    // FAIL-SOFT, and it must be fail-soft in THIS direction. The credential file
    // is already gone when the clear runs, so answering 500 would tell the user
    // the account is still there when it is not — a second lie on top of the
    // first. The pin staying stale is the lesser harm and is itself asserted: the
    // region returns to the reported dead end after a restart, but no user is
    // ever told the removal did not happen.
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, accounts: { cn: DEAD, global: SIBLING }, regions: { cn: { enabled: true } } })
    writable = false

    await expect(removeCnAccount(DEAD)).resolves.toMatchObject({ status: 200 })
    expect(accountWrites()).toEqual([])
    expect(persistedAccounts()['cn']).toBe(DEAD)
    expect((await removeCnAccount(DEAD)).status).toBe(200)
  })
})
