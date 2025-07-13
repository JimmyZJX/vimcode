import { Editor } from "../editorInterface";

export type Options = {};

export type GlobalState = {
  // TODO this should be a class
  textRegister: Record<string, { fullLine: boolean; content: string }>;
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
    globalState: { textRegister: {} },
    flash: {},
  };
}

export type Action<I, O> = (editor: Editor, env: Env, input: I) => O;

type ChordMapper<I, O> = <R>(
  k: <Inner>(map: (inner: Inner) => O, inner: ChordEntry<I, Inner>) => R
) => R;

export type ChordEntry<I, O> =
  | { type: "menu"; chords: Chords<I, O> }
  | { type: "action"; action: Action<I, O> }
  | { type: "map"; mapper: ChordMapper<I, O> };

export type Chords<I, O> = {
  keys: Record<string, ChordEntry<I, O> | undefined>;
  fallback?: Action<{ key: string; input: I }, ChordEntry<I, O> | undefined>;
};

export function getKey<I, O>(
  { keys, fallback }: Chords<I, O>,
  key: string,
  editor: Editor,
  env: Env,
  input: I
): ChordEntry<I, O> | undefined {
  return keys[key] || (fallback && fallback(editor, env, { key, input }));
}

export type ChordMenuMapper<I, O> = <R>(
  k: <Inner>(map: (inner: Inner) => O, chords: Chords<I, Inner>) => R
) => R;

export type CollapsedChordEntry<I, O> =
  | { type: "menu"; menu: ChordMenuMapper<I, O> }
  | { type: "action"; action: Action<I, O> };

export function simpleKeys<I, O>(
  actions: Record<string, Action<I, O> | undefined>
): Record<string, ChordEntry<I, O> | undefined> {
  return Object.fromEntries(
    Object.entries(actions).map(([k, action]) => [
      k,
      action && { type: "action", action },
    ])
  );
}

// TODO set mode to operator-pending (or should we set it globally whenever a sequence
// is pending?)
// TODO free-monad-like type definition to help?
// TODO fix and refactor this
export function runChordWithCallback<I, O, Output2>({
  chords,
  callback,
}: {
  chords: Chords<I, O>;
  callback: Action<{ input: I; output: O }, Output2>;
}): Action<{ key: string; input: I }, ChordEntry<I, Output2> | undefined> {
  return (editor, env, { key, input }) => {
    const entry = getKey(chords, key, editor, env, input);
    if (entry === undefined) return undefined;

    if (entry.type === "menu") {
      return {
        type: "menu",
        chords: {
          keys: {},
          fallback: runChordWithCallback({
            chords: entry.chords,
            callback,
          }),
        },
      };
    } else if (entry.type === "action") {
      return {
        type: "action",
        action: (editor, env, input) => {
          const output = entry.action(editor, env, input);
          return callback(editor, env, { input, output });
        },
      };
    } else {
      // TODO
      throw new Error("unimplemented");
    }
  };
}

export function collapse<I, O>(
  mapper: ChordMapper<I, O>
): CollapsedChordEntry<I, O> {
  return mapper((map, inner) => {
    if (inner.type === "map") {
      return inner.mapper((map_, inner_) => {
        return collapse((k) => k((x) => map(map_(x)), inner_));
      });
    } else if (inner.type === "action") {
      return {
        type: "action",
        action: (editor, env, input) => map(inner.action(editor, env, input)),
      };
    } else {
      return {
        type: "menu",
        menu: (k) => k(map, inner.chords),
      };
    }
  });
}

export function createMenuWithMap<I, Inner, O>(
  chords: Chords<I, Inner>,
  map: (inner: Inner) => O
): ChordMenuMapper<I, O> {
  return (k) => k(map, chords);
}

export function createMenu<I, O>(chords: Chords<I, O>): ChordMenuMapper<I, O> {
  return createMenuWithMap(chords, (x) => x);
}

/** `getInput` should be fast */
export function testKeys<I, O>({
  editor,
  keys,
  chords,
  getInput,
  onOutput,
  env,
}: {
  editor: Editor;
  keys: string[];
  chords: Chords<I, O>;
  getInput: () => I;
  onOutput: (output: O) => void;
  env: Env;
}): void {
  const init: ChordMenuMapper<I, O> = (k) => k((x) => x, chords);
  let cur = init;

  for (const key of keys) {
    const r:
      | { type: "none" }
      | { type: "processed"; state: ChordMenuMapper<I, O> }
      | { type: "output"; output: O } = cur((map, chords) => {
      let entry = getKey(chords, key, editor, env, getInput());

      if (entry === undefined) return { type: "none" };
      const collapsed: CollapsedChordEntry<I, O> = collapse((k) =>
        k(map, entry)
      );
      if (collapsed.type === "menu") {
        return {
          type: "processed",
          state: collapsed.menu,
        };
      } else {
        const oldFlash = env.flash;
        const output = collapsed.action(editor, env, getInput());
        if (env.flash === oldFlash) {
          env.flash = {};
        }
        return { type: "output", output };
      }
    });

    if (r.type === "none") {
      throw new Error(`Chord not found: ${keys.join(" ")}`);
    } else if (r.type === "processed") {
      cur = r.state;
    } else {
      onOutput(r.output);
      cur = init;
    }
  }

  if (cur !== init) {
    throw new Error("Chords not fully applied: " + keys.join(" "));
  }
}
