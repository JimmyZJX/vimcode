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
