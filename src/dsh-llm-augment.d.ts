/**
 * Module augmentation for `MessageSourceMap`.
 *
 * `MessageSource` is `MessageSourceMap[keyof MessageSourceMap]`, and the map is
 * MERGE-EXTENSIBLE on purpose — `@deepseek-ai/dsh-llm`'s own doc comment on it
 * reads: "each producer declares its own `kind` in its own module; there is no
 * shared catch-all `plugin` kind … consumers fall through unknown kinds."
 *
 * So a plugin that puts a message in front of the model declares its own kind
 * here instead of borrowing `'user'`. `'user'` is not a neutral default: it is a
 * claim that the user typed this, and the transcript renders it that way (the
 * injected result shows up in the user bubble, right-aligned, indistinguishable
 * from something the human wrote).
 *
 * `dsh-connect-atomcode` does the same thing with `'atomcode-bridge'`.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codebuddy-bridge': {
      kind: 'codebuddy-bridge'
    }
    /**
     * The automatic 「继续」 sent after the gateway's channel gate refused a
     * turn (see `src/channel-continue.ts`).
     *
     * Its own kind for the same reason as above — and one more: the engine's
     * counter must be able to tell "the human typed something" (`kind: 'user'`)
     * from "the plugin sent this". If both arrived as `'user'`, the plugin's own
     * message would reset the consecutive counter and the cap of 3 could never
     * be reached.
     *
     * `form: 'notice'` is the honest classification: one thing happened, it
     * supersedes nothing, and the UI may show it as a one-line account rather
     * than as a conversation turn the user authored.
     */
    'workbuddy-continue': {
      kind: 'workbuddy-continue'
      form: 'notice'
      summary: string
    }
  }
}

export {}
