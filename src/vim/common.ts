import { Editor } from "../editorInterface";

export type Options = {};

export type Action<Input, Output> = (
  editor: Editor,
  options: {},
  input: Input
) => Output;

export type ChordEntry<Input, Output> =
  | { type: "menu"; chords: Chords<Input, Output> }
  | { type: "action"; action: Action<Input, Output> };
// TODO extend to functions
// | { type: "callback"; callback: Action<Input, ChordEntry<Input, Output>> };

export type Chords<Input, Output> = Record<string, ChordEntry<Input, Output>>;
