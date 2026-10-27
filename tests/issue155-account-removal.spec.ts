/**
 * Issue #155, second report: removing an account must not leave the region
 * pinned to it in the settings document.
 *
 * THE REPORT. 「删了一个账号就这样了」 — CN turned into「已保存的账号在本机已不存在」
 * and the account list rendered nothing. The reporter diagnosed it correctly and
 * escaped by hand-posting `{"field":"accounts","value":{"cn":""}}` to the card's
 * save endpoint.
 *
 * WHY THE IN-MEMORY FORGET WAS NOT ENOUGH. `removeAccount` does drop the
 * selection (`src/auth.ts`), so the region keeps working for the rest of that
 * process. But the settings document still named the dead id, and every
 * `applySelection` re-reads it — a restart, or any settings save — so the region
 * returned to the same dead end. The reporter's own evidence is the config file:
 * `accounts: cn: cd…38 ← 本机已不存在的 id`.
 *
 * THE RULE THESE TESTS PIN. Clear the pin ONLY for the region whose PERSISTED
 * selection names the account being removed. Two failure modes sit on either
 * side of that line, and both are the bug this plugin already refuses elsewhere:
 *
 *   - clearing a region that pinned something else = silently moving the user
 *     off the account they chose, i.e. changing who pays. 「换账号等于换人计费」
 *     is why `current()` refuses to fall back at all (see `tests/auth.spec.ts`);
 *     a removal must not do through the settings file what the store will not do
 *     in memory.
 *   - clearing nothing = keeping the orphan, which is the reported bug.
 *
 * So both directions are asserted, not just the happy path.
 *
 * THE SENTINEL, NOT A DELETED KEY. `''` means "follow the app's current sign-in"
 * (the documented default, and what a fresh install does). An ABSENT key means
 * "never configured" and falls through to the legacy flat `accountId`
 * (`selectAccountFor`), which would resurrect whichever account that field names
 * — a silent switch through another door. Pinned below, including the pre-split
 * profile that pins ONLY through that legacy field.
 *
 * THE MERGE. `accounts` is one flat two-key map that BOTH regions write, so the
 * write preserves the sibling — the same discipline `nextRegion*` and
 * `mergeRegionCatalog` exist for. A live `{get(): T}` reference must also never
 * reach the payload: the settings service `structuredClone`s it and rejects a
 * function outright ("found a function at $.ops[0].value.get"), which is the
 * documented failure of the card's own save path.
 *
 * @module dsh-connect-workbuddy/tests/issue155-account-removal
 */

import { describe, expect, it } from 'vitest'
import { clearRegionAccountSelection } from '../src/catalog-write.ts'
import type { HostSettingsService } from '../src/catalog-write.ts'
import { accountsMapOf, nextAccountsSelection, regionPinsAccount } from '../src/status-paths.ts'

/** The DELETED account's id, as it survives in the reporter's config file. */
const DEAD = 'cd0f1a2b3c4d5e6f7a8b9c0d'
/** Another local account, still healthy, pinned by the SIBLING region. */
const ALIVE = 'aa11bb22cc33dd44ee55ff66'

/** A resolved settings SECTION as `describe()` delivers it. */
function sectionOf(accounts: unknown): Record<string, unknown> {
  return {
    authFile: '',
    accounts,
    regions: { cn: { enabled: true, lastCatalog: [] }, global: { enabled: true } },
    cliBridge: { enabled: false },
  }
}

/** A service whose `describe()` answers one section, recording every mutation. */
function serviceWith(
  value: unknown,
  calls: { path: readonly string[]; value: unknown }[],
): HostSettingsService {
  return {
    describe: () => [{ ns: 'workbuddy', value }],
    mutate: async (_ns, ops) => {
      calls.push(...ops.map(op => ({ path: op.path, value: op.value })))
    },
  }
}

describe('regionPinsAccount: which regions does removing this account orphan?', () => {
  it('yes for the region whose slot names it', () => {
    const section = sectionOf({ cn: DEAD, global: ALIVE })
    expect(regionPinsAccount(section, 'cn', DEAD)).toBe(true)
  })

  it('no for the sibling region, which pins a different account', () => {
    // The half that must not be cleared: global is healthy and paying.
    const section = sectionOf({ cn: DEAD, global: ALIVE })
    expect(regionPinsAccount(section, 'global', DEAD)).toBe(false)
  })

  it('no for a region that never chose one (follows the app already)', () => {
    expect(regionPinsAccount(sectionOf({ cn: '', global: ALIVE }), 'cn', DEAD)).toBe(false)
    expect(regionPinsAccount(sectionOf({}), 'cn', DEAD)).toBe(false)
  })

  it('yes for a pre-split profile pinned ONLY through the legacy flat field', () => {
    // `accounts` is empty, so the read falls back to `accountId` — but only for
    // the region the startup scan attributed it to.
    const section = { ...sectionOf({}), accountId: DEAD }
    expect(regionPinsAccount(section, 'cn', DEAD, DEAD, 'cn')).toBe(true)
    expect(regionPinsAccount(section, 'global', DEAD, DEAD, 'cn')).toBe(false)
  })

  it('reads through a volatile live reference, not the reference itself', () => {
    // On 0.1.7 the field arrives as `{get(): …}`. Spreading THAT is
    // `{get: <function>}`, which the settings service rejects — and a lookup on
    // it answers nothing, so the pin would read as absent and the orphan stay.
    const live = { get: () => ({ cn: DEAD, global: ALIVE }) }
    expect(regionPinsAccount(sectionOf(live), 'cn', DEAD)).toBe(true)
  })
})

describe('nextAccountsSelection: writes one region without touching the other', () => {
  it('clears the target region and preserves the sibling verbatim', () => {
    expect(nextAccountsSelection(sectionOf({ cn: DEAD, global: ALIVE }), 'cn', ''))
      .toEqual({ cn: '', global: ALIVE })
  })

  it('answers the accounts FIELD, never the section around it', () => {
    // The `mutate(path: ['accounts'])` contract: handing it the section buries
    // the map one level down — the exact shape error that caused the "restart
    // reset" report for `regions`.
    const written = nextAccountsSelection(sectionOf({ cn: DEAD }), 'cn', '')
    expect('authFile' in written).toBe(false)
    expect('regions' in written).toBe(false)
  })

  it('keeps the empty-string sentinel as data, distinct from an absent key', () => {
    const cleared = nextAccountsSelection(sectionOf({ cn: DEAD }), 'cn', '')
    expect(cleared['cn']).toBe('')
    expect('cn' in cleared).toBe(true)
  })
})

describe('clearRegionAccountSelection: the persisted half of a removal', () => {
  it('writes the sentinel for the region that pinned the removed account', async () => {
    const calls: { path: readonly string[]; value: unknown }[] = []
    const service = serviceWith(sectionOf({ cn: DEAD, global: ALIVE }), calls)
    await expect(clearRegionAccountSelection(service, 'workbuddy', 'cn', DEAD)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toEqual(['accounts'])
    expect(calls[0]?.value).toEqual({ cn: '', global: ALIVE })
  })

  it('writes NOTHING for a region that pinned some other account', async () => {
    // Removing an unused account must not un-pin the one the user is paying with.
    const calls: { path: readonly string[]; value: unknown }[] = []
    const service = serviceWith(sectionOf({ cn: ALIVE, global: ALIVE }), calls)
    await expect(clearRegionAccountSelection(service, 'workbuddy', 'cn', DEAD)).resolves.toBe(false)
    expect(calls).toEqual([])
  })

  it('writes NOTHING when the region is already following the app', async () => {
    const calls: { path: readonly string[]; value: unknown }[] = []
    const service = serviceWith(sectionOf({ cn: '' }), calls)
    await expect(clearRegionAccountSelection(service, 'workbuddy', 'cn', DEAD)).resolves.toBe(false)
    expect(calls).toEqual([])
  })

  it('clears a legacy-only profile through the same single write', async () => {
    // The flat `accountId` still decides this region, so writing `accounts.cn`
    // must be the sentinel: `selectAccountFor` TERMINATES on the sentinel and
    // never falls back to the legacy field again.
    const calls: { path: readonly string[]; value: unknown }[] = []
    const service = serviceWith({ ...sectionOf({}), accountId: DEAD }, calls)
    await expect(
      clearRegionAccountSelection(service, 'workbuddy', 'cn', DEAD, DEAD, 'cn'),
    ).resolves.toBe(true)
    expect(calls[0]?.value).toEqual({ cn: '' })
  })

  it('carries the sibling pin through a volatile field without leaking the reference', async () => {
    const calls: { path: readonly string[]; value: unknown }[] = []
    const value = sectionOf({ get: () => ({ cn: DEAD, global: ALIVE }) })
    await clearRegionAccountSelection(serviceWith(value, calls), 'workbuddy', 'cn', DEAD)
    const written = calls[0]?.value as Record<string, unknown>
    expect(written).toEqual({ cn: '', global: ALIVE })
    // A function anywhere in the payload = `mutate` rejects the whole save.
    expect(Object.values(written).some(entry => typeof entry === 'function')).toBe(false)
  })

  it('is a no-op without a settings service or without the namespace', async () => {
    const refusal: HostSettingsService = {
      describe: () => [{ ns: 'someone-else', value: {} }],
      mutate: async () => { throw new Error('must not be called') },
    }
    await expect(clearRegionAccountSelection(undefined, 'workbuddy', 'cn', DEAD)).resolves.toBe(false)
    await expect(clearRegionAccountSelection(refusal, 'workbuddy', 'cn', DEAD)).resolves.toBe(false)
  })

  it('reads the live document rather than trusting a stale merge base', async () => {
    // Two regions, both pinned; only CN's account is being removed. If the write
    // were built from a snapshot that predated global's change, global's pin
    // would be reverted here — the failure `regionsMapOf` documents for `regions`.
    const calls: { path: readonly string[]; value: unknown }[] = []
    const service = serviceWith(sectionOf({ cn: DEAD, global: 'switched-after-boot' }), calls)
    await clearRegionAccountSelection(service, 'workbuddy', 'cn', DEAD)
    expect((calls[0]?.value as Record<string, unknown>)['global']).toBe('switched-after-boot')
  })
})

describe('accountsMapOf: narrowing the field out of a section', () => {
  it('accepts the section, the field, a live reference, and junk', () => {
    expect(accountsMapOf(sectionOf({ cn: DEAD }))).toEqual({ cn: DEAD })
    expect(accountsMapOf({ cn: DEAD, global: ALIVE })).toEqual({ cn: DEAD, global: ALIVE })
    expect(accountsMapOf({ get: () => ({ cn: DEAD }) })).toEqual({ cn: DEAD })
    expect(accountsMapOf(undefined)).toEqual({})
    expect(accountsMapOf('nope')).toEqual({})
    expect(accountsMapOf([{ cn: DEAD }])).toEqual({})
  })

  it('does not hop into a nested copy when the outer object IS the map', () => {
    // A region map can legitimately carry an `accounts` key of its own (an older
    // writer left sibling field names in `regions`); reading THAT would answer a
    // different, older copy of the same region — the reason `regionsMapOf` made
    // the hop conditional.
    const map = { cn: DEAD, accounts: { cn: 'stale-older-copy' } }
    expect(accountsMapOf(map)).toEqual(map)
  })
})
