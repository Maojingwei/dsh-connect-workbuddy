/**
 * 「被网关渠道校验拦截」时自动再发一次「继续」——可选、有上限。
 *
 * ## 这条功能要解决的那一次失败
 *
 * 用户粘贴的原文：
 *
 *   本轮运行失败400: {"message":"workbuddy 上游失败：被网关的渠道校验拦截（不是账号、
 *   额度或网络问题）（http 400）（code 11128，requestId …）。…",
 *   "type":"channel_reject","code":"channel_reject"}
 *
 * 它被 `classifyUpstreamError` 判成 `channel_reject`（`src/upstream.ts`），而这个类
 * **刻意不换号**（`isFailoverWorthy`，`src/shim.ts`）：网关匹配的是请求里消息的开头，
 * 换账号只会每个账号白烧一次真实请求。所以插件在同一请求内跑完三级救援阶梯
 * （`forceNeutralHead` → 一次零宽扰动 → 密集零宽扰动）之后，就把 400 原样交给宿主。
 *
 * 宿主也不会替我们重发：`channel_reject` 走的是 400，`code` 又是它不认识的字符串，
 * 不在 `DEFAULT_RETRYABLE_CODES` 里，于是这一轮直接结束，用户看到的正是上面那句。
 *
 * ## 为什么「再发一次」确实可能成功
 *
 * `docs/PINNED-11128-RETRY.md` §2 记录了两条互相矛盾的事实：插件自己在
 * `perturbChannelFingerprints` 旁的注释说「给定提示词被拒是确定性的」，而现场报告
 * （#87–#98、#113）反复出现「把这条消息再发一次就过了」。二者都能成立，原因是**每
 * 一次新回合都是一份新的请求**：宿主会把当前 surface 重新组装、注入块的位置与内容
 * 可能变化、插件也可能因为学到偏好而从第一发就带扰动。所以「重发一次」不是把被拒
 * 的字节原样再塞一遍（那才是真正的浪费），而是**开一个新回合**。
 *
 * 本模块就是把这个「手动再发一次」自动化，并且**只做这件事**：
 *
 * - 只认 `channel_reject` 这一种失败。配额、限流、网络、内容审核都有各自的处置，
 *   那些失败再发「继续」只会多烧一次请求（`NO_CONTINUE_CODES` 的同一判断）。
 * - 上限默认 **1** 次，**连续**计数：一次成功回合或一条真实用户消息立即清零。
 *   旧默认是 3；#163 的实测把「新回合会换掉被拒内容」证伪了（固定 system 指纹每轮
 *   相同，3 次只是把同一个 400 付三遍），所以一次足够：1 次救不了，3 次也救不了。
 * - 不做换号、不换区域、不改请求内容、不重试同一份字节：换号对这类拒绝无效，而
 *   篡改请求才是这条功能不该碰的东西。
 * - 子代理会话一律不碰：子代理由父代理驱动，抢跑会打乱执行树。
 *
 * 它是**最后兜底**，不是 11128 的修复：固定指纹由 `prepareChatBody` 的按句改词处理；
 * 改词后仍 11128，多半是新的固定指纹，重发同样无效。只有「被拒内容刚好随轮次变化」
 * 的窄情况才可能靠它碰过去，所以默认关闭、默认只发 1 次。
 *
 * 参考：`dsh-client-auto-continue`（MIT，HsiangNianian/dsh-auto-continue）—
 *   「连续失败上限」这套**语义**取自它：`state.consecutive` 在每次发出时自增、
 *   `consecutive >= maxConsecutive` 就停、只在真正成功的回合清零、子代理会话按
 *   `session.header.origin === 'subagent'` 跳过、发消息用
 *   `agent.followup(createUserMessage(...))`。本模块**没有**照搬它的引擎：那个实现
 *   有 1590 行，覆盖收尾原因矩阵、自适应退避、自主循环、循环守卫与浏览器通知，而
 *   这里只需要「一种失败、一条消息、一个上限」。
 * 参考：`dsh-purge`（MIT，YuJunZhiXue/dsh-purge）的 `lib/continue-retry.js` —
 *   三处具体做法：**被排除的失败码清单**（`NO_CONTINUE_CODES`：配额、限流、传输
 *   这些「重发也拿同一句回答」的失败不该续）、**收件箱忙就不插队**（`inboxBusy`），
 *   以及用 `user/message` 的 `source.kind` 区分「真人介入」与「插件自己发的」，以免
 *   自己的回显把上限清零。
 * 改动：本项目相对两者都是**收窄**，不是扩展——（a）只认 `channel_reject` 这一种
 *   失败，两套参考实现都是「除永久码外一律续」；（b）不做原地重试、不做换号、不做
 *   退避，因为这一类失败换谁、隔多久都是同一份请求；（c）计数状态只活在进程里、不
 *   落盘（参考实现有持久化文件），因为「刚刚这一串失败」本来就是即时的事实；（d）把
 *   订阅交给调用方注入（`onSessionEvent`），因为本插件没有 `@deepseek-ai/dsh-session`
 *   这条 peer 依赖，也不该为一条监听引入它。
 *
 * @module dsh-connect-workbuddy/channel-continue
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * 自动续发消息的 `source.kind`。
 *
 * 不用 `'user'`：那等于声称这条消息是用户敲的，转录里会渲染成右对齐的用户气泡，
 * 用户既没说过这句话、也就无从判断它是谁发的。`MessageSourceMap` 是**可合并扩展**
 * 的（其自带注释：「each producer declares its own kind in its own module」），
 * 声明在 `src/dsh-llm-augment.d.ts`。`dsh-connect-atomcode` / `dsh-purge` 同样做法。
 */
export const CONTINUE_SOURCE_KIND = 'workbuddy-continue'

/** 默认自动续发的次数上限：1 次。见模块头：3 次在固定指纹上只是多付两遍。 */
export const DEFAULT_MAX_CONSECUTIVE = 1

/** 默认续发的文本。用户要的就是「继续」两个字。 */
export const DEFAULT_CONTINUE_TEXT = '继续'

/** 上限的硬边界：0 等于关闭，超过 10 次已经不属于「再试一次」的语义。 */
const MAX_CONSECUTIVE_CEILING = 10

/**
 * 发出前的等待。
 *
 * `turn/end` 是在回合**已经收尾**之后追加的，但宿主紧接着还要把这一步的状态落定；
 * 立刻 `followup` 有机会撞上宿主自己的收尾动作。300ms 是 `dsh-purge` 的
 * `continue-retry` 在同一位置实测可用的量级，这里取同一个值，不另挑一个没有依据的数。
 */
const SEND_DELAY_MS = 300

/** 每个进程最多记多少个会话的计数（长开进程的 FIFO 兜底，`dsh-purge` 同一做法）。 */
const SESSION_CAP = 200

/** 超过时一次丢多少个。 */
const SESSION_EVICT = 50

/** 引擎读到的一份配置（已归一化）。 */
export interface ChannelContinueSettings {
  /** 是否启用。只有显式 true 才算开启。 */
  enabled: boolean
  /** 连续自动续发的次数上限（已夹在 1..10）。 */
  maxConsecutive: number
  /** 续发时发送的文本。 */
  text: string
}

/**
 * 把配置里的两个标量归一化成一个可用的设置对象。
 *
 * 两处「防御」都是有意为之：`enabled` 只认显式 `true`（这条功能会花真实请求，
 * 缺失或畸形必须读成「关」），`maxConsecutive` 与 `text` 越界时退回默认值，
 * 因为一个 `0`/`NaN`/空白文本会让功能变成静默空转——那比关着更难查。
 *
 * @param enabled - 配置里的开关标量。
 * @param max - 配置里的上限标量。
 * @param text - 配置里的文本。
 * @returns 归一化后的设置。
 */
export function channelContinueSettingsOf(
  enabled: unknown,
  max: unknown,
  text: unknown,
): ChannelContinueSettings {
  const wanted = typeof max === 'number' && Number.isFinite(max) ? Math.trunc(max) : DEFAULT_MAX_CONSECUTIVE
  const capped = Math.min(MAX_CONSECUTIVE_CEILING, Math.max(1, wanted))
  const body = typeof text === 'string' && text.trim() !== '' ? text.trim() : DEFAULT_CONTINUE_TEXT
  return { enabled: enabled === true, maxConsecutive: capped, text: body }
}

/**
 * 这段失败是不是「被网关渠道校验拦截」。
 *
 * 不能只看 `code`。插件在 shim 里写的是 `type: "channel_reject"` 与
 * `code: "channel_reject"`（`KIND_STATUS` / 未翻译的 kind），但宿主拿到的
 * `LlmFailure.code` 由 pi-ai 从**消息文本**重新分类（`classifyPiAiError`，
 * `@deepseek-ai/dsh-llm-pi-ai`）：`/\b400\b/` 命中就归成 `INVALID_REQUEST`。
 * 也就是说 host 侧这一份 `code` 极可能不是 `channel_reject`，而那句插件自
 * 己的话（连同 JSON 里的 `channel_reject`）一定在 `message` 里。
 *
 * 于是判断刻意「够宽但锚得准」：命中插件自己的 kind 字面量或它自己的那句中文说明，
 * 就算这一类；其余一切（配额、限流、审核、网络、模型不可用）都不算——它们各有
 * 自己的处置，重发「继续」只会多花一次真实请求。
 *
 * @param failure - `turn/end` 的 `reason.error`，形状按 `LlmFailure` 读。
 * @returns 是否属于渠道门拒绝。
 */
export function isChannelRejectFailure(failure: unknown): boolean {
  if (typeof failure !== 'object' || failure === null) return false
  const record = failure as { code?: unknown, message?: unknown }
  if (typeof record.code === 'string' && record.code === 'channel_reject') return true
  const message = record.message
  if (typeof message !== 'string' || message === '') return false
  // JSON 里的 kind 字面量：宿主把整段响应体拼进了 message。
  if (message.includes('channel_reject')) return true
  // 插件在 `failoverReasonText` 里写的那句中文说明。
  return message.includes('渠道校验拦截')
}

/** 引擎从宿主那里需要的 agent 切片（结构化声明，不 import 宿主类型）。 */
export interface ContinueAgent {
  readonly status?: string
  readonly session?: { readonly header?: { readonly origin?: string } }
  followup(message: unknown): void
  readonly inbox?: unknown
}

/** 引擎依赖：全部注入，所以逻辑可以在没有宿主的情况下逐条验证。 */
export interface ChannelContinueHost {
  /** 读**当前**配置（活值，用户拨动开关后下一次失败立刻生效）。 */
  getConfig(): ChannelContinueSettings
  /** 按会话 id 取活的 agent。 */
  getAgent(sessionId: string): ContinueAgent | undefined
  /** 记一行诊断（永不抛出）。 */
  log(message: string): void
}

/** 一个会话的计数状态。 */
interface SessionState {
  /** 已连续自动续发的次数。 */
  consecutive: number
  /** 已排定、还没发出的那一次（`null` 表示没有，不用 `undefined`：
   * `exactOptionalPropertyTypes` 下可选属性不接受显式 `undefined`）。 */
  pending: ReturnType<typeof setTimeout> | null
  /** 已经处理过的 `turn/end` 序号，防止同一事件被重复计入。 */
  lastHandledSeq: number
  /**
   * 已就「撞到上限」记过一条日志。
   *
   * 单独一个标志位，不再拿 `consecutive` 自增当标记：那样 `stateOf()` 会报出
   * 「上限 3 次、已连续 4 次」这种自相矛盾的读数，而诊断读数正是排查这条功能
   * 时唯一能看到的东西。
   */
  capped: boolean
}

/** 引擎句柄。 */
export interface ChannelContinue {
  /** `session/event` 的入口。 */
  onSessionEvent(session: unknown, event: unknown): void
  /** 取消所有待发并把状态清空（插件卸载时调用）。 */
  dispose(): void
  /** 只读快照，给测试与诊断用。 */
  stateOf(sessionId: string): { consecutive: number, pending: boolean } | undefined
}

/** 结构化的会话切片。 */
function sessionIdOf(session: unknown): string {
  const id = (session as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : ''
}

/** 子代理会话：它的回合由父代理驱动，插件不该插手。 */
function isSubagentSession(session: unknown, agent: ContinueAgent | undefined): boolean {
  if ((session as { header?: { origin?: unknown } } | undefined)?.header?.origin === 'subagent') return true
  return agent?.session?.header?.origin === 'subagent'
}

/**
 * agent 的收件箱里是否已经有人排队。
 *
 * 只做「看起来非空」的结构探测，覆盖宿主不同版本的三种表示（`hasPending()` /
 * `size` / `length`）。有排队就放弃这一次续发：用户很可能刚敲了一条消息，此时插一条
 * 「继续」会让他的提问排到自动消息后面。
 */
function inboxBusy(agent: ContinueAgent): boolean {
  const inbox = agent.inbox
  if (typeof inbox !== 'object' || inbox === null) return false
  const probe = inbox as { hasPending?: unknown, size?: unknown, length?: unknown }
  try {
    if (typeof probe.hasPending === 'function' && (probe.hasPending as () => unknown)() === true) return true
    if (typeof probe.size === 'number' && probe.size > 0) return true
    if (typeof probe.length === 'number' && probe.length > 0) return true
  } catch {
    // 探测失败按「不忙」处理：宁可多发一次，也不要让功能在某个宿主版本上永不触发。
  }
  return false
}

/**
 * 建一台自动续发引擎。
 *
 * 只认 `session/event` 上的三件事：`turn/end`（判失败/清计数）、`turn/start`
 * （取消待发）、`user/message`（真人插话就把计数清零）。没有轮询、没有扫描、
 * 没有持久化：计数失效于进程即可，它描述的本来就是「刚刚这一串失败」。
 *
 * @param host - 注入的宿主依赖。
 * @returns 引擎句柄。
 */
export function createChannelContinue(host: ChannelContinueHost): ChannelContinue {
  const states = new Map<string, SessionState>()
  let disposed = false

  const stateOf = (sessionId: string): SessionState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      if (states.size >= SESSION_CAP) {
        // Map 保持插入顺序：丢最早的一批，长开进程才不会被历史会话撑爆。
        let dropped = 0
        for (const key of states.keys()) {
          if (dropped >= SESSION_EVICT) break
          const victim = states.get(key)
          if (victim?.pending !== null && victim?.pending !== undefined) clearTimeout(victim.pending)
          states.delete(key)
          dropped += 1
        }
      }
      state = { consecutive: 0, lastHandledSeq: 0, pending: null, capped: false }
      states.set(sessionId, state)
    }
    return state
  }

  const cancelPending = (state: SessionState): void => {
    if (state.pending === null) return
    clearTimeout(state.pending)
    state.pending = null
  }

  /** 真的把「继续」发出去。所有放弃的分支都留一行日志，不静默。 */
  const fire = (sessionId: string, state: SessionState, session: unknown): void => {
    state.pending = null
    if (disposed) return
    const config = host.getConfig()
    if (!config.enabled) return
    const agent = host.getAgent(sessionId)
    if (agent === undefined) {
      host.log(`跳过自动续发 ${sessionId}：会话已没有 live agent`)
      return
    }
    if (isSubagentSession(session, agent)) return
    // 已经在跑就别再塞一条：这一次失败之后宿主可能自己起了新回合（重试策略、
    // 压缩、用户点了继续），再 followup 会变成两条并行的意图。
    if (agent.status === 'running') {
      host.log(`跳过自动续发 ${sessionId}：回合已经在跑`)
      return
    }
    if (inboxBusy(agent)) {
      host.log(`跳过自动续发 ${sessionId}：收件箱里已有排队内容`)
      return
    }
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: config.text }],
        source: { kind: CONTINUE_SOURCE_KIND, form: 'notice', summary: 'channel-reject-continue' },
      })
      agent.followup(message)
      state.consecutive += 1
      host.log(
        `已自动发送「${config.text}」到 ${sessionId}（被渠道校验拦截），`
        + `第 ${String(state.consecutive)}/${String(config.maxConsecutive)} 次连续`,
      )
      if (state.consecutive >= config.maxConsecutive) {
        host.log(`已达连续上限 ${String(config.maxConsecutive)} 次，${sessionId} 不再自动续发，等用户介入`)
      }
    } catch (error: unknown) {
      host.log(`自动续发失败 ${sessionId}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    onSessionEvent(session: unknown, event: unknown): void {
      if (disposed) return
      const sessionId = sessionIdOf(session)
      if (sessionId === '') return
      const record = event as { type?: unknown, seq?: unknown, data?: any } | undefined
      const type = record?.type
      if (typeof type !== 'string') return
      const state = stateOf(sessionId)

      if (type === 'turn/start') {
        // 宿主自己开了新回合：那条已排定的「继续」已经没有意义。
        cancelPending(state)
        return
      }

      if (type === 'user/message') {
        const kind = record?.data?.source?.kind
        // 只有真人文本清零。我们自己发的、其他插件注入的都不算「用户介入」——
        // 否则我们发的这条会把计数清掉，上限就永远不会生效。
        if (kind === 'user') {
          cancelPending(state)
          state.consecutive = 0
          state.capped = false
        }
        return
      }

      if (type !== 'turn/end') return

      // 同一个 turn/end 只处理一次（事件可能被重放或多处监听转发）。
      const seq = typeof record?.seq === 'number' ? record.seq : 0
      if (seq !== 0 && state.lastHandledSeq === seq) return
      state.lastHandledSeq = seq

      const reason = record?.data?.reason
      const kind = typeof reason === 'object' && reason !== null ? (reason as { kind?: unknown }).kind : undefined

      // 一次成功回合 = 这一串失败结束了，计数清零。「blocked」（策略拒绝）、
      // 「max-tokens」、「interrupted」不清也不发：它们不是这一类失败。
      if (kind === 'completed') {
        cancelPending(state)
        state.consecutive = 0
        state.capped = false
        return
      }
      // 用户主动停止：视为介入，清零（同 `dsh-purge` / `auto-continue` 的处置）。
      if (kind === 'aborted') {
        const cause = (reason as { reason?: { kind?: unknown } } | undefined)?.reason
        if (cause?.kind === 'user') {
          cancelPending(state)
          state.consecutive = 0
          state.capped = false
        }
        return
      }
      if (kind !== 'error') return

      const failure = (reason as { error?: unknown }).error
      if (!isChannelRejectFailure(failure)) return

      const config = host.getConfig()
      if (!config.enabled) return
      if (state.pending !== null) return
      if (state.consecutive >= config.maxConsecutive) {
        // 只在第一次撞上上限时记一行：之后每一轮都记会把日志刷满。
        if (!state.capped) {
          state.capped = true
          host.log(`已达连续上限 ${String(config.maxConsecutive)} 次，${sessionId} 停止自动续发`)
        }
        return
      }

      host.log(
        `检测到渠道门拒绝 ${sessionId}，${String(SEND_DELAY_MS)}ms 后自动发送`
        + `「${config.text}」（第 ${String(state.consecutive + 1)}/${String(config.maxConsecutive)} 次）`,
      )
      state.pending = setTimeout(() => {
        try {
          fire(sessionId, state, session)
        } catch (error: unknown) {
          // 定时器回调里任何异常都不得成为未捕获异常：这是宿主进程。
          host.log(`自动续发回调异常 ${sessionId}：${error instanceof Error ? error.message : String(error)}`)
        }
      }, SEND_DELAY_MS)
      // 定时器不该维持进程存活：宿主退出时它随时可以被丢掉。
      ;(state.pending as unknown as { unref?: () => void }).unref?.()
    },

    dispose(): void {
      disposed = true
      for (const state of states.values()) {
        if (state.pending !== null) clearTimeout(state.pending)
        state.pending = null
      }
      states.clear()
    },

    stateOf(sessionId: string): { consecutive: number, pending: boolean } | undefined {
      const state = states.get(sessionId)
      if (state === undefined) return undefined
      return { consecutive: state.consecutive, pending: state.pending !== null }
    },
  }
}

/** 安装时需要的宿主切片。 */
export interface ChannelContinueMount extends ChannelContinueHost {
  /** 订阅 `session/event`，返回退订函数。 */
  onSessionEvent(listener: (session: unknown, event: unknown) => void): () => void
}

/**
 * 把引擎挂到宿主的事件总线上。
 *
 * 订阅走注入的 `onSessionEvent`，而不是在这里 `ctx.on`：宿主把 `session/event`
 * 声明在 `@deepseek-ai/dsh-session` 的类型里，本插件没有也不该有那条 peer 依赖，
 * 由调用方用一行鸭子类型的 cast 提供，才能让这个模块在没装宿主包的测试里也能跑。
 *
 * @param mount - 宿主切片。
 * @returns 卸载函数（取消订阅并清空计数）。
 */
export function installChannelContinue(mount: ChannelContinueMount): () => void {
  const engine = createChannelContinue(mount)
  let off: (() => unknown) | undefined
  try {
    off = mount.onSessionEvent((session, event) => {
      engine.onSessionEvent(session, event)
    })
  } catch (error: unknown) {
    // A host that does not emit `session/event` must leave this feature INERT,
    // not fail the plugin's mount: the switch is off by default, the providers
    // and the card are unrelated to it, and taking the whole plugin down for an
    // optional listener would turn a missing convenience into a broken install.
    // Say so once, with the reason, so a user who turned the switch on and saw
    // nothing happen can find out why.
    mount.log(
      `未能订阅 session/event，自动续发不可用（插件其余部分不受影响）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    engine.dispose()
    return () => {}
  }
  return () => {
    try {
      off?.()
    } catch {
      // 宿主可能已经先一步拆掉了总线；卸载不该反过来抛。
    }
    engine.dispose()
  }
}
