// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `state::VimGlobals`, `state::MarksState`, and per-editor `vim::Vim`
// - translated concepts: explicit ownership boundaries for global Vim state and
//   per-model Vim state.
// - intentional differences: this local split is shaped around VSCode's editor widget
//   lifecycle, where an editor can temporarily have no attached text model while tabs
//   are switching.

import { FindState } from "./normal/find.js";
import { ChangeListState } from "./normal/change_list.js";
import { MarkState } from "./normal/mark.js";
import { MacroState, RepeatState } from "./normal/repeat.js";
import { SearchState } from "./normal/search.js";
import { PromptHistory } from "./prompt_history.js";
import { Registers } from "./registers.js";
import { Position } from "./state.js";

export class VimGlobalState {
  readonly registers = new Registers();
  readonly search = new SearchState();
  /** `:` command-line history (the `/`?` history lives in [search]). */
  readonly commandHistory = new PromptHistory();
  readonly repeat = new RepeatState();
  readonly macro = new MacroState();
  readonly find = new FindState();
  /** Ex options toggled with `:set`; only options that change core command
      semantics live here (`:h gdefault`). */
  readonly exOptions = { gdefault: false };
}

export class VimModelState {
  readonly marks = new MarkState();
  readonly changeList = new ChangeListState();
  lastInsertPosition: Position | undefined;
}
