import { Editor } from "../editorInterface.js";
import { Registers } from "./registers.js";

export type Options = {};

export type GlobalState = {
  registers: Registers;
};

export type Flash = {
  preferredColumn?: number;
};

export type Env = {
  options: Options;
  globalState: GlobalState;
  flash: Flash;
};

export function emptyEnv(): Env {
  return {
    options: {},
    globalState: { registers: new Registers() },
    flash: {},
  };
}

export type DelayedAction<I, O> = <R>(
  k: <DelayedInput>(
    prepare: Action<I, Promise<DelayedInput>>,
    delayed: Action<DelayedInput, O>
  ) => R
) => R;

export type Action<I, O> = (editor: Editor, env: Env, input: I) => O;

export type ChordEntry<I, O> =
  | { type: "menu"; menu: ChordMenu<I, O> }
  | { type: "action"; action: Action<I, O> }
  | { type: "delayed"; delayed: DelayedAction<I, O> };

export type ChordKeymap<I, O> = Record<string, ChordEntry<I, O> | undefined>;

export abstract class ChordMenu<I, O> {
  abstract followKey(
    input: I,
    key: string,
    editor: Editor,
    env: Env
  ): ChordEntry<I, O> | undefined;
}

export class KeyChordMenu<I, O> extends ChordMenu<I, O> {
  constructor(readonly keymap: ChordKeymap<I, O>) {
    super();
  }

  followKey(
    _input: I,
    key: string,
    _editor: Editor,
    _env: Env
  ): ChordEntry<I, O> | undefined {
    return this.keymap[key];
  }
}

export class DynamicChordMenu<I, O> extends ChordMenu<I, O> {
  constructor(
    readonly fn: Action<{ key: string; input: I }, ChordEntry<I, O> | undefined>
  ) {
    super();
  }

  followKey(
    input: I,
    key: string,
    editor: Editor,
    env: Env
  ): ChordEntry<I, O> | undefined {
    return this.fn(editor, env, { key, input });
  }
}

export class MappedChordMenu<I, InnerI, InnerO, O> extends ChordMenu<I, O> {
  constructor(
    readonly mapInput: (input: I) => InnerI,
    readonly inner: ChordMenu<InnerI, InnerO>,
    readonly mapOutput: Action<{ input: I; output: InnerO }, O>
  ) {
    super();
  }

  followKey(
    input: I,
    key: string,
    editor: Editor,
    env: Env
  ): ChordEntry<I, O> | undefined {
    const entry = this.inner.followKey(this.mapInput(input), key, editor, env);
    if (entry === undefined) {
      return undefined;
    }

    if (entry.type === "action") {
      return {
        type: "action",
        action: (editor, env, input) => {
          const rawOutput = entry.action(editor, env, this.mapInput(input));
          return this.mapOutput(editor, env, { input, output: rawOutput });
        },
      };
    }

    if (entry.type === "delayed") {
      return {
        type: "delayed",
        delayed: (k) =>
          entry.delayed((prepare, delayed) =>
            k(
              async (editor, env, input) => {
                const delayedInput = await prepare(
                  editor,
                  env,
                  this.mapInput(input)
                );
                return { delayedInput, input };
              },
              (editor, env, { delayedInput, input }) => {
                const rawOutput = delayed(editor, env, delayedInput);
                return this.mapOutput(editor, env, { input, output: rawOutput });
              }
            )
          ),
      };
    }

    return {
      type: "menu",
      menu: new MappedChordMenu(this.mapInput, entry.menu, this.mapOutput),
    };
  }
}

export class MultiChordMenu<I, O> extends ChordMenu<I, O> {
  constructor(readonly menus: readonly ChordMenu<I, O>[]) {
    super();
  }

  followKey(
    input: I,
    key: string,
    editor: Editor,
    env: Env
  ): ChordEntry<I, O> | undefined {
    const entries = this.menus.flatMap((menu) => {
      const entry = menu.followKey(input, key, editor, env);
      return entry !== undefined ? [entry] : [];
    });

    if (entries.length === 0) return undefined;
    if (entries.length === 1) return entries[0];

    // Multiple entries found - respect first match
    const firstType = entries[0].type;
    if (firstType === "action" || firstType === "delayed") {
      // Actions and delayed actions: return first match
      return entries[0];
    }

    // Menus: merge all menus together
    const menus = entries.flatMap((entry) =>
      entry.type === "menu" ? [entry.menu] : []
    );
    return { type: "menu", menu: new MultiChordMenu(menus) };
  }
}

export function simpleKeys<I, O>(
  actions: Record<string, Action<I, O> | undefined>
): ChordKeymap<I, O> {
  return Object.fromEntries(
    Object.entries(actions).map(([k, action]) => [
      k,
      action && { type: "action", action },
    ])
  );
}

/** `getInput` should be fast */
export async function testKeys<I, O>({
  editor,
  keys,
  chords,
  getInput,
  onOutput,
  env,
}: {
  editor: Editor;
  keys: string[];
  chords: ChordMenu<I, O>;
  getInput: () => I;
  onOutput: (output: O) => void;
  env: Env;
}): Promise<void> {
  const init = chords;
  let cur = init;

  for (const key of keys) {
    const r = cur.followKey(getInput(), key, editor, env);
    if (r === undefined) {
      throw new Error(`Chord not found: ${keys.join(" ")}`);
    }
    if (r.type === "menu") {
      cur = r.menu;
    } else if (r.type === "action") {
      // In test, every key chord triggers a flash
      const oldFlash = env.flash;
      const output = r.action(editor, env, getInput());
      if (env.flash === oldFlash) {
        env.flash = {};
      }
      onOutput(output);
      cur = init;
    } else {
      await r.delayed(async (prepare, delayed) => {
        const prepared = await prepare(editor, env, getInput());

        const oldFlash = env.flash;
        const output = delayed(editor, env, prepared);
        if (env.flash === oldFlash) {
          env.flash = {};
        }
        onOutput(output);
        cur = init;
      });
    }
  }

  if (cur !== init) {
    throw new Error(
      "Chords not fully applied: " +
        keys.join(" ") +
        "\nJSON\n====\n" +
        JSON.stringify(cur)
    );
  }
}
