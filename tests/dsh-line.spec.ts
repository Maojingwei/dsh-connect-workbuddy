import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guard the declared DSH host line: the lower bound, the upper bound, and —
 * the part that actually failed — the fact that the upper bound BITES.
 *
 * ## Why this exists
 *
 * 0.1.7 线期间，8~10 条 `dsh-*` peer 写的是 `>=0.1.7-rc.1 <0.2.0`。这个上界在当时
 * 是对的，但它有一个**只在下一个版本线落地那一刻才显形**的缺陷：
 *
 *   - `0.2.0-rc.1 < 0.2.0` 成立 → 整条 0.2.0 预发布线被放行（所以 0.2.0-rc.1 上一切正常）
 *   - `0.2.0 < 0.2.0` 不成立     → 正式版一发布，10 条 peer 全部失败
 *
 * DSH 的 shipped 门禁（`packages/boot/app-boot/src/plugin-compatibility.ts`，
 * `evaluatePluginCompatibility`）对这 10 条逐条判定：**只要有一条不满足，整个组合包
 * 就被 `loadProfileDirectory` 跳过**，只写进 `skippedBundles` 并由
 * `reportSkippedBundles` 打到 stderr。它不是崩溃，是**静默消失**——provider 不注册、
 * 卡片不出现、模型列表清空，页面上没有任何提示。
 *
 * 本次复核已经在本机实测到这条路径**正在生效**：0.2.0-rc.1 宿主上，`dsh-rewind-plugin`
 * (`^0.1.7-rc.2`)、`dsh-free-search` (`^0.1.7-rc.1`)、`dsh-better-reasoning-effort`、
 * `@changfenhuang/dsh-genui` 四个组合包都因此**没有出现在实时组合里**
 * （`listConfigs` 共 203 条，其中无一条来自它们；同 profile 内 peer 全通过的包全部在场）。
 *
 * ## 为什么是 `<0.3.0-0` 而不是 `<0.3.0`
 *
 * DSH 至今 **23 个 tag 全部是预发布**（`-alpha.N` / `-rc.N`），从未发过 GA。所以：
 *
 *   - `<0.3.0`   只挡 `0.3.0` GA —— 而 GA 永远不来 —— 上界**永不生效**，
 *                同时静默放行 `0.3.0-alpha.1` / `0.3.0-rc.1` 整条从未验证过的线。
 *                这正是今天这个缺陷的形状：**看起来是围栏，实际不挡任何东西。**
 *   - `<0.3.0-0` 显式挡掉 `0.3.0-0`（含）以上的一切预发布与 GA，围栏真的会响。
 *
 * `-0` 是 semver 里"该版本线的最小可能预发布"，因此 `<0.3.0-0` 的意思是
 * 「0.3.0 线一个都不放」。这与同作者同架构的 `dsh-connect-trae` 2.3.0 的处置一致
 * （其 `docs/DSH_0.2.0_RC1_IMPACT_CHECK.md` §4 记录了同一处判断）。
 *
 * ## 这些用例为什么读文件而不是导入
 *
 * 1. 要断言的是**发布出去的清单**，`package.json` 才是权威副本（`inject` 那套同理）。
 * 2. `peerDependencies` 是给 shipped 门禁读的**数据**，不是给本仓库 import 的代码。
 * 3. 本仓库没有 `semver` 依赖，而引入它只为跑一条断言不划算；下面用一个
 *    小而完整的 semver 序比较直接判定边界，不依赖任何第三方解析器。
 *
 * 变异验证：把任一条改回 `<0.2.0` → 上界用例变红；把 `<0.3.0-0` 改成 `<0.3.0` →
 * 「上界必须真的挡住下一线预发布」那条变红；把下界抬到 `>=0.2.0-rc.1` → 下界用例变红。
 */

const repoRoot = new URL('../', import.meta.url)

/** Parsed `package.json` of the published package. */
function manifest(): {
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(fileURLToPath(new URL('package.json', repoRoot)), 'utf8'))
}

/**
 * 每条 `dsh-*` peer 的期望上界。
 *
 * 写成常量而不是就地拼字符串，是为了让「上界该是多少」这件事只有一个出处：
 * 改这里就等于改口径，而下面的用例会同时盯住声明与实际边界行为。
 */
const UPPER_BOUND = '<0.3.0-0'
const LOWER_BOUND = '>=0.1.7-rc.1'

/** 每个声明了 `dsh-*` peer 的包名与其范围。 */
function dshPeers(section: 'peerDependencies' | 'devDependencies'): Array<[string, string]> {
  const deps = manifest()[section] ?? {}
  return Object.entries(deps).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
}

/**
 * 判定一个版本是否落在 `>= 下界 < 上界` 形态的范围里，**按 npm semver 的
 * 真实语义**求值，包括那条最容易写错的「预发布悬崖」。
 *
 * 存在的理由：下面「上界真的挡得住」那几条**必须对声明本身求值**，而不是对
 * 测试里另写一遍的字面量求值。否则声明与断言各自漂移也照样全绿——那正是本
 * 套件要防的那类「看起来是围栏、实际不挡」的缺陷，只不过换了一层。
 *
 * ## 为什么不能只做朴素的 `>=` / `<` 比较（本套件曾经的缺陷）
 *
 * 初版直接比较下界与上界，于是判 `0.2.1-rc.1` 落在 `>=0.1.7-rc.1 <0.3.0-0`
 * 里 —— npm 实算是 **false**。semver 规定：
 *
 * > 预发布版本**只有**当同一比较器集合里存在**同一 `major.minor.patch`
 * > 元组**上的预发布比较符时，才被放行。
 *
 * `>=0.1.7-rc.1` 只对 `0.1.7-x` 开口，`<0.3.0-0` 排除整个 `0.3.0` 元组，
 * 于是 `0.2.1-rc.1`（元组 `0.2.1`）**两条都不满足**。
 *
 * 而旧夹具恰好列了 `0.2.0-rc.1` 与 `0.2.1`、独独跳过真实发布的 `0.2.1-rc.1`，
 * 所以这个错比较器从未被触发 —— 「看起来是围栏，实际不挡」的又一例。
 *
 * 现在两件事一起修：比较器按规范实现，夹具补上真实的 rc 版本。
 */
function satisfiesRange(version: string, range: string): boolean {
  const parts = range.trim().split(/\s+/)
  if (parts.length !== 2) throw new Error(`unsupported range shape: ${JSON.stringify(range)}`)
  const [lower, upper] = parts as [string, string]
  if (!lower.startsWith('>=') || !upper.startsWith('<')) {
    throw new Error(`unsupported range shape: ${JSON.stringify(range)}`)
  }
  const candidate = parseVersion(version)
  const lowerV = parseVersion(lower.slice(2))
  const upperV = parseVersion(upper.slice(1))
  if (compareParsed(candidate, lowerV) < 0) return false
  if (compareParsed(candidate, upperV) >= 0) return false

  // The prerelease cliff: a prerelease candidate is admitted only when some
  // comparator in the set carries a prerelease on the SAME [major, minor,
  // patch] tuple.
  if (candidate.pre.length === 0) return true
  return [lowerV, upperV].some(
    bound => bound.pre.length > 0 && sameTuple(bound, candidate),
  )
}

/** One parsed semver version. */
interface ParsedVersion {
  nums: [number, number, number]
  pre: (string | number)[]
}

/** Parse `x.y.z` or `x.y.z-pre.N`; throw rather than silently mis-compare. */
function parseVersion(value: string): ParsedVersion {
  const [core, ...rest] = value.split('-')
  const pre = rest.join('-')
  const nums = (core ?? '').split('.').map(part => {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0) throw new Error(`not a version core: ${JSON.stringify(value)}`)
    return n
  })
  if (nums.length !== 3) throw new Error(`not a full x.y.z version: ${JSON.stringify(value)}`)
  return {
    nums: nums as [number, number, number],
    pre: pre === '' ? [] : pre.split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)),
  }
}

/** Same `[major, minor, patch]` tuple. */
function sameTuple(a: ParsedVersion, b: ParsedVersion): boolean {
  return a.nums[0] === b.nums[0] && a.nums[1] === b.nums[1] && a.nums[2] === b.nums[2]
}

/** Total order over parsed versions (build metadata is ignored, as in semver). */
function compareParsed(left: ParsedVersion, right: ParsedVersion): -1 | 0 | 1 {
  for (let i = 0; i < 3; i += 1) {
    const l = left.nums[i] as number
    const r = right.nums[i] as number
    if (l !== r) return l < r ? -1 : 1
  }
  // A prerelease sorts BELOW the same-numbered release (1.0.0-rc.1 < 1.0.0).
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const len = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNum = typeof l === 'number'
    const rNum = typeof r === 'number'
    if (lNum && rNum) return l < r ? -1 : 1
    if (lNum) return -1 // numeric identifiers sort below alphanumeric ones
    if (rNum) return 1
    return l < r ? -1 : 1
  }
  return 0
}

/**
 * 从**真实清单**里取出那一条 `dsh-*` 声明，作为边界断言的求值对象。
 *
 * 取 `peerDependencies` 的第一条：上面已有一条用例断言所有 `dsh-*` 范围完全一致，
 * 所以任取一条即代表全部；这里再校验一次形态，避免把不一致悄悄当成一致。
 */
function declaredRange(): string {
  const ranges = new Set(dshPeers('peerDependencies').map(([, range]) => range))
  if (ranges.size !== 1) {
    throw new Error(`dsh-* peers disagree on their range: ${JSON.stringify([...ranges])}`)
  }
  const only = [...ranges][0]
  if (only === undefined) throw new Error('no dsh-* peer dependency declared')
  return only
}

describe('declared DSH host line', () => {
  it('declares at least the ten dsh packages the plugin actually imports', () => {
    // 反向兜底：这十条是源码真实 import 的那批（见 `src/` 的 kernel imports）。
    // 少一条意味着有人删声明却没删引用，或反之——两者都该当场发现。
    const names = dshPeers('peerDependencies').map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-settings',
    ]))
    expect(names.length).toBeGreaterThanOrEqual(10)
  })

  it('keeps every dsh-* peer on the same lower and upper bound', () => {
    // 本次缺陷的形态就是「上界写死在某一版」；统一的上下界让下一轮复核只需看一处。
    for (const section of ['peerDependencies', 'devDependencies'] as const) {
      for (const [name, range] of dshPeers(section)) {
        expect(range, `${section}.${name}`).toBe(`${LOWER_BOUND} ${UPPER_BOUND}`)
      }
    }
  })

  it('admits the whole 0.2.0 line, including its GA release', () => {
    // 回归本体：`0.2.0` 曾被 `<0.2.0` 挡在门外——「GA 放不进来」的悬崖。
    // 这件事对**正式版**成立：`0.2.0` / `0.2.1` 都被现声明放行。
    //
    // 关键：对**声明里的那条范围**求值，而不是对测试自己另写的字面量求值。
    // 否则清单与断言各自漂移也能全绿。
    //
    // ⚠️ 本用例原先还把 `0.2.0-rc.1` / `0.2.0-rc.9` 也列为 admitted。那是**错的**：
    // npm semver 对两者都判 false（元组 `0.2.0` 上没有任何预发布比较符）。
    // 旧比较器判 true，才让这条错误夹具一直是绿的。它们现在归到下面的
    // 「已知预发布悬崖」用例里，作为应被记录的偏差。
    const declared = declaredRange()
    for (const host of ['0.1.7-rc.1', '0.1.7-rc.2', '0.2.0', '0.2.1', '0.2.99']) {
      expect(satisfiesRange(host, declared), `${host} in ${JSON.stringify(declared)}`).toBe(true)
    }
  })

  it('records the known 0.2.x-prerelease cliff rather than hiding it', () => {
    // 已知偏差，**不是**通过项：现声明 `>=0.1.7-rc.1 <0.3.0-0` 在 npm semver
    // 下**不**放行 `0.2.1-rc.1` 这类序号 > 0.2.0 的预发布（元组上没有预发布
    // 比较符）。这条用例把这个事实**钉成期望值**，于是：
    //   - 若有人把范围改对（例如逐补丁追加 rc 窗口），这条会变红，提醒同步
    //     更新说明，而不是静默漂移；
    //   - 若有人「修」比较器把它判成 true，这条同样变红。
    //
    // 为什么 rc 宿主上插件照常加载（0.2.1-rc.3 实测）——**原因是宿主的判定口径**，
    // 不是链接方式。`evaluatePluginCompatibility()`（`dsh-app-boot/lib/index.js`）
    // 用 `semver.satisfies(rt, range, { includePrerelease: true })` 求值（其内部
    // `:276` 的 `satisfies` 包装即带该第三参数）。因此 `0.2.1-rc.3` 对现声明判
    // **true**，兼容闸门从未拦过 rc 宿主。
    //
    // ⚠️ 此处原先写的是「闸门只校验 `@deepseek-ai/dsh*` 命名空间；profile 用
    // `link:` 且默认不自动装 peer，所以 rc 宿主照常加载」。那个解释是**错的**：
    // 闸门确实校验，只是用 `includePrerelease` 放过。本用例钉的「裸 semver 判
    // false」始终成立，错的只是对**为什么没被拦**的归因，现已按实测订正。
    //
    // 范围本身仍不改：`includePrerelease` 也会放行 `0.3.0-rc.1`，而 `<0.3.0-0`
    // 把它挡住（见下一条用例）。等宿主发 `0.2.1` GA，现声明同样放行。
    const declared = declaredRange()
    expect(satisfiesRange('0.2.1-rc.1', declared)).toBe(false)
    expect(satisfiesRange('0.2.0-rc.1', declared)).toBe(false)
    // GA 是被放行的 —— 这正是「等 GA」策略成立的前提。
    expect(satisfiesRange('0.2.1', declared)).toBe(true)
  })

  it('the upper bound actually stops the next line, prereleases included', () => {
    // 这条是 `<0.3.0-0` 与 `<0.3.0` 的唯一区别，也是本次复核最重要的一条：
    // DSH 至今 23 个 tag 全部是预发布，所以「只挡 GA」的上界等于不挡。
    const declared = declaredRange()
    for (const host of ['0.3.0-0', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '0.4.0-rc.1']) {
      expect(satisfiesRange(host, declared), `${host} must be blocked by ${JSON.stringify(declared)}`).toBe(false)
    }
  })

  it('still refuses hosts older than the declared baseline', () => {
    // 下界不是本次改动对象，但同一处口径必须一起守住：0.1.5 线已移除，
    // 停在 v2.0.15 的用户不应被这一版静默接受。
    const declared = declaredRange()
    for (const host of ['0.1.5-rc.3', '0.1.6-alpha.1', '0.1.7-alpha.2']) {
      expect(satisfiesRange(host, declared), `${host} must be refused`).toBe(false)
    }
  })

  it('does not silently drop the two client packages the card composes against', () => {
    // `ui-settings` / `ui-renderer` 承载客户端的 `configForms` 与 `slots` 服务声明；
    // 它们掉出 peer 列表不会让构建失败，只会让卡片在运行时不出现。
    const peers = manifest().peerDependencies ?? {}
    for (const name of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-renderer']) {
      expect(peers[name], name).toBe(`${LOWER_BOUND} ${UPPER_BOUND}`)
    }
  })

  it('marks the host-supplied pi-ai peer optional, so an install is not rejected for it', () => {
    // ISSUE #151. `@earendil-works/pi-ai` is a REQUIRED peer in range terms —
    // the plugin imports it statically, so it must be present at run time — but
    // it is never installed into a profile: the host carries it as its own
    // dependency (`dsh-llm-pi-ai`'s `dependencies`, `^1.1.0`) and answers the
    // bare specifier through its runtime interception layer, while profiles are
    // created with `autoInstallPeers: false`.
    //
    // A required peer in that situation is unsatisfiable at INSTALL time, and a
    // host that validates the install closure rejects the generation: the user
    // sees a successful install, then the plugin is swept on restart (#151).
    // `optional` states the truth — "supplied by the host, do not require me to
    // ship it" — without weakening the RANGE, which stays the supported
    // boundary the runtime probe reads.
    const meta = (manifest() as { peerDependenciesMeta?: Record<string, { optional?: boolean }> })
      .peerDependenciesMeta ?? {}
    expect(meta['@earendil-works/pi-ai']?.optional, 'pi-ai must be optional').toBe(true)

    // The range itself must NOT move: marking it optional is about install
    // validation, not about what this plugin supports at run time.
    const peers = manifest().peerDependencies ?? {}
    expect(peers['@earendil-works/pi-ai']).toBe('>=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0')
  })

  it('does not keep a devDependency on a package that stopped publishing', () => {
    // `dsh-client-runtime` 停在 0.1.1-rc.2、不在任何受支持主机的捆绑集内，且源码零引用。
    // 它此前作为「旧主机行的类型来源」被保留，但那条线已随 2.1.0 移除——保留只会让
    // 清单与 lockfile 继续声称一份并不存在的依赖。
    const dev = manifest().devDependencies ?? {}
    expect(dev['@deepseek-ai/dsh-client-runtime']).toBeUndefined()
  })
})

describe('host-range policy is written down where releases read it', () => {
  /**
   * 上界这类口径**只有在人看得到的地方被复核**才不会过期，而发布清单是唯一
   * 「每次发布都必然被读到」的位置（2.1.1 对 `docs/WINDOWS.md` 的处置同理）。
   * 这几条是 POLICY 断言，不是行为断言：它们不证明上界是对的，只证明这条
   * 复核路径还在——少了它，下一次 DSH 换线时没人会被提醒。
   */
  function read(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, repoRoot)), 'utf8')
  }

  it('keeps the host-range check in the release flow', () => {
    const releasing = read('RELEASING.md')
    expect(releasing).toContain('宿主范围核对')
    expect(releasing).toContain(UPPER_BOUND)
    // 必须说明 -0 的理由，否则下一个人会「顺手」把它删成 <0.3.0。
    expect(releasing).toContain('-0')
  })

  it('keeps the supported-range table in both READMEs', () => {
    expect(read('README.md')).toContain('受支持的宿主范围')
    expect(read('README.en.md')).toContain('Supported host range')
    // 两语的表都必须点名被拒绝的那条线，而不是只写好话。
    for (const doc of ['README.md', 'README.en.md']) {
      expect(read(doc), doc).toContain('0.3.0-0')
    }
  })
})

describe('the GitHub Release step stays in the release flow', () => {
  /**
   * POLICY assertions, not behaviour assertions. 创建 GitHub Release 对 CI、对
   * npm、对测试**都没有任何影响**，所以漏掉它时不会有任何东西报错——历史上
   * `v2.0.0` / `v2.0.16` / `v2.0.17` 就是这么漏掉的，`v2.1.1` 的 Release 也比
   * npm 发布晚了将近两天才补上。它只能靠「发布清单里写着」来保证，因此这里
   * 盯住清单里那几步与那两条形态约定是否还在。
   */
  function read(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, repoRoot)), 'utf8')
  }

  it('keeps the create-release step documented', () => {
    const releasing = read('RELEASING.md')
    expect(releasing).toContain('创建 GitHub Release')
    // The two halves that make the step reproducible rather than improvised.
    expect(releasing).toContain('gh release create')
    expect(releasing).toContain('--verify-tag')
  })

  it('keeps the title/body conventions the historical releases follow', () => {
    const releasing = read('RELEASING.md')
    // The historical name shape is `vX.Y.Z — <一句话>` (em dash), NOT the colon
    // the tag message uses; drift here makes every future release look different
    // from the 16 already published.
    expect(releasing).toContain('vX.Y.Z — ')
    // The body is a curated announcement — never a copy of the CHANGELOG
    // section, and never gh's auto-generated commit list.
    expect(releasing).toContain('--notes-file')
    expect(releasing).toContain('--generate-notes')
  })

  it('declares the gh prerequisite the step depends on', () => {
    expect(read('RELEASING.md')).toContain('gh auth status')
  })
})

describe('version-comparator self-check', () => {
  // 上面全部断言都建立在比较器上；它自己错了，整套守卫就是装饰品。
  //
  // 这段自检**真的救过一次**：初版的 `satisfiesRange` 只做朴素 `>=`/`<`
  // 比较，判 `0.2.1-rc.1` 通过，而 npm 实算是 false。下面的悬崖用例就是
  // 那次缺陷的回归钉。
  it('orders prereleases below their release and compares numeric segments', () => {
    expect(compareParsed(parseVersion('1.0.0-rc.1'), parseVersion('1.0.0'))).toBe(-1)
    expect(compareParsed(parseVersion('1.0.0'), parseVersion('1.0.0-rc.1'))).toBe(1)
    expect(compareParsed(parseVersion('1.0.0-rc.2'), parseVersion('1.0.0-rc.10'))).toBe(-1)
    expect(compareParsed(parseVersion('0.2.0'), parseVersion('0.3.0-0'))).toBe(-1)
    expect(compareParsed(parseVersion('0.3.0-0'), parseVersion('0.3.0-0'))).toBe(0)
    expect(compareParsed(parseVersion('0.3.0-alpha.1'), parseVersion('0.3.0-0'))).toBe(1)
    expect(compareParsed(parseVersion('1.2.0'), parseVersion('1.10.0'))).toBe(-1)
    expect(compareParsed(parseVersion('0.1.7-rc.1'), parseVersion('0.1.7-rc.1'))).toBe(0)
  })

  it('rejects malformed versions instead of treating them as equal', () => {
    expect(() => parseVersion('0.2')).toThrow()
    expect(() => parseVersion('x.y.z')).toThrow()
  })

  it('applies the prerelease cliff exactly as npm semver does', () => {
    // These five lines are literal transcriptions of npm semver 7.x output.
    // The first one is the defect the old comparator had: it said `true`.
    const range = '>=0.1.7-rc.1 <0.3.0-0'
    expect(satisfiesRange('0.2.1-rc.1', range)).toBe(false)
    expect(satisfiesRange('0.2.0-rc.1', range)).toBe(false)
    expect(satisfiesRange('0.1.7-rc.1', range)).toBe(true)
    expect(satisfiesRange('0.2.1', range)).toBe(true)

    // A comparator carrying a prerelease on the SAME tuple admits it...
    expect(satisfiesRange('0.2.1-rc.1', '>=0.2.1-rc.1 <0.3.0-0')).toBe(true)
    // ...and one on a DIFFERENT tuple does not.
    expect(satisfiesRange('0.2.5-rc.1', '>=0.2.1-rc.1 <0.3.0-0')).toBe(false)
    // The `-0` upper bound still bites the next line, prereleases included.
    for (const host of ['0.3.0-0', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0']) {
      expect(satisfiesRange(host, range), host).toBe(false)
    }
  })
})
