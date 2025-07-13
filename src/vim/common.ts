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

export type Action<Input, Output> = (
  editor: Editor,
  env: Env,
  input: Input
) => Output;

export type ChordEntry<Input, Output> =
  | {
      type: "menu";
      chords: Chords<Input, Output>;
      fallback?: Action<
        { key: string; input: Input },
        ChordEntry<Input, Output> | undefined
      >;
    }
  | { type: "action"; action: Action<Input, Output> };

export type Chords<Input, Output> = Record<
  string,
  ChordEntry<Input, Output> | undefined
>;

export function simpleKeys<Input, Output>(
  actions: Record<string, Action<Input, Output> | undefined>
): Chords<Input, Output> {
  return {
    ...Object.fromEntries(
      Object.entries(actions).map(([k, action]) => [
        k,
        action && { type: "action", action },
      ])
    ),
  };
}

// TODO set mode to operator-pending (or should we set it globally whenever a sequence
// is pending?)
export function runChordWithCallback<Input, Output, Output2>({
  chords,
  fallback,
  callback,
}: {
  chords: Chords<Input, Output>;
  fallback:
    | Action<
        { key: string; input: Input },
        ChordEntry<Input, Output> | undefined
      >
    | undefined;
  callback: Action<{ input: Input; output: Output }, Output2>;
}): Action<
  { key: string; input: Input },
  ChordEntry<Input, Output2> | undefined
> {
  return (editor, env, { key, input }) => {
    const entry: ChordEntry<Input, Output> | undefined =
      chords[key] || (fallback && fallback(editor, env, { key, input }));
    if (entry === undefined) return undefined;

    if (entry.type === "menu") {
      return {
        type: "menu",
        chords: {},
        fallback: runChordWithCallback({
          chords: entry.chords,
          fallback: entry.fallback,
          callback,
        }),
      };
    } else {
      return {
        type: "action",
        action: (editor, env, input) => {
          const output = entry.action(editor, env, input);
          return callback(editor, env, { input, output });
        },
      };
    }
  };
}

/** `getInput` should be fast */
export function testKeys<Input, Output>({
  editor,
  keys,
  chords,
  getInput,
  onOutput,
  env,
}: {
  editor: Editor;
  keys: string[];
  chords: Chords<Input, Output>;
  getInput: () => Input;
  onOutput: (output: Output) => void;
  env: Env;
}): void {
  let cur = chords;
  let fallback:
    | Action<
        { key: string; input: Input },
        ChordEntry<Input, Output> | undefined
      >
    | undefined = undefined;

  for (const k of keys) {
    const entry: ChordEntry<Input, Output> | undefined =
      cur[k] ||
      (fallback && fallback(editor, env, { key: k, input: getInput() }));
    if (entry === undefined) {
      throw new Error("Chords not found: " + keys.join(" "));
    }
    if (entry.type === "menu") {
      cur = entry.chords;
      fallback = entry.fallback;
    } else {
      const oldFlash = env.flash;
      const output = entry.action(editor, env, getInput());
      if (env.flash === oldFlash) {
        env.flash = {};
      }
      onOutput(output);

      cur = chords;
      fallback = undefined;
    }
  }

  if (cur !== chords) {
    throw new Error("Chords not fully applied: " + keys.join(" "));
  }
}
