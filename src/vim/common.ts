import { Editor } from "../editorInterface";

export type Options = {};

export type Flash = {
  preferredColumn?: number;
};

export type Env = {
  options: Options;
  flash: Flash;
};

export type Action<Input, Output> = (
  editor: Editor,
  env: Env,
  input: Input
) => Output;

export type ChordEntry<Input, Output> =
  | { type: "menu"; chords: Chords<Input, Output> }
  | { type: "action"; action: Action<Input, Output> };
// TODO extend to functions
// | { type: "callback"; callback: Action<Input, ChordEntry<Input, Output>> };

export type Chords<Input, Output> = Record<string, ChordEntry<Input, Output>>;

export function simpleKeys<Input, Output>(
  actions: Record<string, Action<Input, Output>>
): Chords<Input, Output> {
  return {
    ...Object.fromEntries(
      Object.entries(actions).map(([k, action]) => [
        k,
        { type: "action", action },
      ])
    ),
  };
}

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
  for (const k of keys) {
    const entry = cur[k];
    if (entry === undefined) {
      throw new Error("Chords not found: " + keys.join(" "));
    }
    if (entry.type === "menu") {
      cur = entry.chords;
    } else {
      const oldFlash = env.flash;
      const output = entry.action(editor, env, getInput());
      if (env.flash === oldFlash) {
        env.flash = {};
      }
      onOutput(output);
      cur = chords;
    }
  }

  if (cur !== chords) {
    throw new Error("Chords not fully applied: " + keys.join(" "));
  }
}
