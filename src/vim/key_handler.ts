import type { CommandLine } from "./command.js";
import type { VimCommandMapping, VimConfiguration, WhenEvaluator } from "./config.js";
import type { EasyMotionState } from "./easymotion.js";
import type { VimEditorCapabilities } from "./editor.js";
import type { ChangeListState } from "./normal/change_list.js";
import type { FindState } from "./normal/find.js";
import type { MarkState } from "./normal/mark.js";
import type { MacroState, RepeatState } from "./normal/repeat.js";
import type { PendingSearch, SearchState } from "./normal/search.js";
import type { RegisterName, Registers } from "./registers.js";
import type { Position, VimMode } from "./state.js";
import type { VisualMode } from "./visual.js";

// The normal-mode insert-entry commands, which position the cursor and switch to
// insert mode: `i`/`a`/`I`/`A` and `o`/`O` (open line below/above).
export type InsertEntryKind = "i" | "a" | "I" | "A" | "o" | "O";

export type HandlerState = {
  mode: VimMode;
  // TODO: Move this into a typed count/repeat handler once counts no longer
  // live in Vim's shared environment. It stays here for now to preserve the
  // existing leading-zero and status-display behavior during migration.
  repeat: number;
  // In-progress count digits as typed (e.g. "2", "23"), before being applied as
  // a numeric [repeat]. This is the canonical count buffer shared between the
  // legacy dispatcher and the typed framework during the normal-mode migration.
  countText: string;
  register: RegisterName | undefined;
  operatorDepth: number;
  whenEvaluator: WhenEvaluator;
  // Whether the current key is allowed to trigger user remaps (the per-key
  // "remappable" flag of remap typeahead, à la Vim's :noremap). This is a
  // dispatch-scoped flag (like [whenEvaluator]) rather than long-lived parser
  // state: the executor sets it per [handle] call and per re-dispatched emitted
  // key so non-recursive remap expansions don't remap their own output. It is
  // produced and consumed entirely within remap.ts (see [remapHandler]).
  allowRemap: boolean;
  // Whether an explicit count was typed for the current command. Some keys are
  // count-sensitive (`%` is match-pair without a count, go-to-percentage with
  // one; `G`/`gg` go to the last/first line without a count, to line N with
  // one). Set by [prefixHandler] when it applies a count into [repeat].
  hasCount?: boolean;
  remapKeys: readonly string[];
  editor?: VimEditorCapabilities;
  registers?: Registers;
  marks?: MarkState;
  find?: FindState;
  changeList?: ChangeListState;
  // The cursor position when insert mode was last left, for `gi` (insert at the
  // previous insert position). Injected live like [marks]/[find]; undefined
  // until the first insert session ends.
  lastInsertPosition?: Position;
  // The shared search state (last pattern + incremental prompt UI), for the
  // search motions `n`/`N`/`*`/`#` and the `/`?` prompt. Injected live like
  // [marks]/[find].
  search?: SearchState;
  // The in-flight `/`?` prompt's editable query, while in `search` mode. Owned
  // by [Vim] (mode-entry creates it) and injected live so the pure search-mode
  // grammar can drive it.
  activeSearch?: PendingSearch;
  // The in-flight `:` command line, while in `command` mode. Owned by [Vim]
  // (mode-entry creates it) and injected live so the pure command-mode grammar
  // can accumulate input; execution happens owner-side on the command -> normal
  // transition.
  activeCommand?: CommandLine;
  // The mode `/`?` was entered from, while in `search` mode. When it is a visual
  // kind, the completed search extends the selection and returns to that visual
  // mode instead of moving the cursor and returning to normal. Injected live
  // like [activeSearch].
  searchOrigin?: VimMode;
  // The visual-mode selection state + edit helpers, injected live (like
  // [marks]/[search]) so the pure visual grammar can drive the selection and
  // apply visual operators while in a visual mode.
  visual?: VisualMode;
  // The dot-repeat state, injected so visual operators can record their
  // (same-size) visual repeat action — visual `.` reapplies to an
  // equivalently-shaped selection rather than replaying keys.
  repeatState?: RepeatState;
  // The named-macro state (record/replay registers), for `q`/`@`/`Q`. Injected
  // live like [search]/[repeatState]. Used by the effects that start/stop
  // recording; replay is requested via [requestMacroReplay] instead.
  macro?: MacroState;
  // Request a macro replay (`@{reg}`/`@@` with [register] set, `Q` with
  // [register] undefined). The owner runs it *after* the executor's effect drain
  // — outside it, like a freshly typed key — because replaying feeds keys back
  // through the full pipeline and each must fully apply (mode transitions,
  // edits) before the next; running it inside the drain would defer the
  // framework effects and scramble a replay that passes through insert mode.
  requestMacroReplay?: (register: string | undefined, count: number) => void;
  // `.`: request a replay of the last recorded change. Like [requestMacroReplay],
  // the owner runs it *after* the executor's effect drain — the replay feeds
  // recorded keys back through the dispatcher and each must fully apply before
  // the next. [count]/[register] carry the `3.` / `"a.` overrides.
  requestDotReplay?: (count: number | undefined, register: RegisterName | undefined) => void;
  // Vim `i_CTRL-O`: leave insert mode for exactly one normal-mode command. The
  // owner finishes the insert session, enters normal mode, and flags the
  // excursion so the next completed command returns to insert. Injected live
  // into the insert-mode grammar like [requestMacroReplay].
  enterTemporaryNormal?: () => void;
  // Append resolved text (a digraph, a literal character code) to the insert
  // session's count-repeat text — the text `3i…<esc>` re-inserts. Ordinary typed
  // input accumulates owner-side (see the `typed` recording path); this is for
  // insert-mode commands that resolve to text inside their effect.
  appendInsertSessionText?: (text: string) => void;
  // Replace-mode text application: overwrite [text] at the cursors, remembering
  // what it replaced (for backspace restore) and appending to the count-repeat
  // session text. Injected live into the replace-mode grammar.
  applyReplaceText?: (text: string) => void;
  // Replace-mode backspace: restore the most recently overwritten character at
  // the cursor, or step left when nothing was overwritten there.
  undoReplace?: () => void;
  // The easyMotion overlay state (leader-triggered label jumps), for the `q`-less
  // `<leader><leader>…` chords. Injected live like [search]/[macro]. The handler
  // drives it via [EasyMotionState.decide]/[commit]; [configuration] supplies the
  // leader + easyMotion key tables, and [applyEasyMotionJump] applies the chosen
  // jump (a cursor move in normal mode, a selection extension in visual mode).
  easyMotion?: EasyMotionState;
  configuration?: VimConfiguration;
  applyEasyMotionJump?: (position: Position) => void;
};

export const initialHandlerState: HandlerState = {
  mode: "normal",
  repeat: 1,
  countText: "",
  register: undefined,
  operatorDepth: 0,
  whenEvaluator: () => true,
  allowRemap: true,
  remapKeys: [],
};

export function cloneHandlerState(state: HandlerState): HandlerState {
  return { ...state };
}

export type KeyToDispatch = {
  key: string;
  allowRemap: boolean;
};

export type QueuedRunResult<T> = T | Promise<T>;

// Optional, declarative metadata a leaf effect attaches for the executor/owner
// to act on after the effect runs. Kept as plain data (not callbacks) so the
// grammar stays pure.
export type EffectMeta = {
  // Insert-session parameters for a command whose target [mode] is "insert"
  // (`3i`, `2o`): the typed text is repeated [count] times on exit, [separator]
  // joins the repeats (`\n` for `o`/`O`). Consumed by the owner's mode
  // transition; [mode] already says *that* we enter insert, this says *how*.
  enterInsert?: { count: number; separator: string };
  // Search-prompt parameters for a command whose target [mode] is "search"
  // (`/` forward, `?` backward): the owner's mode transition starts the
  // incremental prompt in this direction.
  search?: { backwards: boolean };
  // Whether this command is a buffer-modifying change that `.` should repeat
  // (Vim's per-command `prep_redo` decision). The command declares it here
  // instead of a separate key list; motions/yank/marks leave it false. Defaults
  // to false when omitted.
  dotRepeatable?: boolean;
  // Whether the owner should reconcile Vim state from the editor after the
  // effect runs (the legacy `syncFromEditorState`). Native commands that move
  // the cursor/open a different editor (`gd`, `gh`, …) set this; the
  // editor-internal sync option (`syncSelectionAfter`) covers the rest. Defaults
  // to false when omitted.
  syncAfter?: boolean;
  // Whether this key is transparent to dot-repeat: the owner should neither open,
  // extend, nor cancel the dot-repeat recording for it. Distinct from
  // `dotRepeatable: false`, which *cancels* — this *preserves*. Used by the
  // macro-control keys (`q`/`@`/`Q` + register): they must not enter the dot
  // register, and `@`/`Q` replay must leave the dot-repeat their replayed keys
  // set intact. Defaults to false when omitted.
  preservesDotRepeat?: boolean;
  // Whether this is a passthrough insert/replace-mode character: VSCode handles
  // the buffer edit (live typing is native; replay/tests go through
  // [editor.replayInsertKey]). The owner records it as a `typed` [RecordedKey]
  // (extending the in-flight change recording) and accumulates the insert
  // session text, rather than running the shortcut record/dot-repeat path. The
  // effect itself is a marker — its [run] does no buffer edit. Defaults to false.
  insertTyped?: boolean;
};

export type EffectAction<T> = {
  type: "effect";
  mode: VimMode;
  run: () => QueuedRunResult<T>;
  // When set, the *actual* target mode is computed by calling this after [run]
  // executes, instead of using the static [mode]. Used by commands whose
  // resulting mode is only known after the side effect runs — e.g. a visual
  // command dispatched through [VisualMode.handleCommand], whose result (stay
  // visual / which visual kind / exit to normal / enter insert) depends on the
  // selection at run time. The static [mode] is the executor's best-guess parser
  // mode while [run] executes (not load-bearing among visual kinds, which share
  // handlers); [resolveMode] is the true transition mode reported to
  // [onEnterMode]. Unlike [EffectMeta] this is a callback, so it lives on the
  // action next to [run] rather than in the plain-data meta.
  resolveMode?: () => VimMode;
} & EffectMeta;

type VoidKeyAction =
  | { type: "keys"; mode: VimMode; keys: readonly KeyToDispatch[] }
  | { type: "commands"; mode: VimMode; commands: readonly VimCommandMapping[] }
  | { type: "sequence"; mode: VimMode; actions: readonly KeyAction<void>[] };

export type KeyAction<T> = EffectAction<T> | (T extends void ? VoidKeyAction : never);

export type Handler<T> = (key: string, state: HandlerState) => HandleResult<T>;

export type HandlerEnv<T> = {
  handler: Handler<T>;
  state: HandlerState;
};

// A side effect to run when a pending continuation is entered (the key that
// left the chord pending is accepted). It runs through the same effect queue as
// command effects — deferred, not during [handle] — so a handler that both
// advances an interactive prompt and stays pending (e.g. the `d/` incremental
// search operand: update the incsearch preview, then wait for the next key) can
// keep its body pure and put the side effect here. Purely a side effect: it
// carries no value and does not transition mode (the chord stays pending).
export type PendingEffect = () => QueuedRunResult<void>;

export type HandleResult<T> =
  | { type: "run"; action: KeyAction<T> }
  | { type: "handler"; handlerEnvs: readonly HandlerEnv<T>[]; effect?: PendingEffect; preservesDotRepeat?: boolean }
  | { type: "conflict"; accepted: KeyAction<T>; pending: readonly HandlerEnv<T>[]; effect?: PendingEffect; preservesDotRepeat?: boolean }
  | { type: "unhandled" }
  | { type: "invalid" };

export function mapHandler<T, U>(
  underlying: Handler<T>,
  f: (value: T, state: HandlerState) => QueuedRunResult<U>
): Handler<U> {
  return (key, state) => {
    const mapAction = (action: KeyAction<T>): KeyAction<U> => {
      if (action.type !== "effect") {
        throw new Error("mapHandler expects effect actions");
      }
      return {
        ...action,
        // Preserve synchronicity: only return a promise when the underlying run
        // is itself async. Forcing this async would defer otherwise-synchronous
        // editor effects to a microtask, which synchronous callers would miss.
        run: () => {
          const inner = action.run();
          return isPromiseLike(inner)
            ? Promise.resolve(inner).then(value => f(value, state))
            : f(inner, state);
        },
      };
    };

    const result = underlying(key, state);
    switch (result.type) {
      case "run":
        return { type: "run", action: mapAction(result.action) };
      case "handler":
        // [effect] is a side-effect-only thunk (void), so it passes through the
        // T -> U mapping unchanged; [preservesDotRepeat] is a plain flag.
        return { type: "handler", handlerEnvs: result.handlerEnvs.map(env => mapHandlerEnv(env, f)), effect: result.effect, preservesDotRepeat: result.preservesDotRepeat };
      case "conflict":
        return {
          type: "conflict",
          accepted: mapAction(result.accepted),
          pending: result.pending.map(env => mapHandlerEnv(env, f)),
          effect: result.effect,
          preservesDotRepeat: result.preservesDotRepeat,
        };
      case "unhandled":
        return { type: "unhandled" };
      case "invalid":
        return { type: "invalid" };
    }
  };
}

function mapHandlerEnv<T, U>(
  env: HandlerEnv<T>,
  f: (value: T, state: HandlerState) => QueuedRunResult<U>
): HandlerEnv<U> {
  return { handler: mapHandler(env.handler, f), state: env.state };
}

export function combineHandleResults<T>(results: readonly HandleResult<T>[]): HandleResult<T> {
  let accepted: KeyAction<T> | undefined;
  let invalidResult: Extract<HandleResult<T>, { type: "invalid" }> | undefined;
  const pending: HandlerEnv<T>[] = [];
  const effects: PendingEffect[] = [];
  let preservesDotRepeat = false;

  for (const result of results) {
    switch (result.type) {
      case "unhandled":
        break;
      case "invalid":
        if (accepted === undefined && pending.length === 0 && invalidResult === undefined) {
          invalidResult = result;
        }
        break;
      case "run":
        if (accepted === undefined) accepted = result.action;
        break;
      case "handler":
        pending.push(...result.handlerEnvs);
        if (result.effect !== undefined) effects.push(result.effect);
        if (result.preservesDotRepeat === true) preservesDotRepeat = true;
        break;
      case "conflict":
        if (accepted === undefined) accepted = result.accepted;
        pending.push(...result.pending);
        if (result.effect !== undefined) effects.push(result.effect);
        if (result.preservesDotRepeat === true) preservesDotRepeat = true;
        break;
    }
  }

  const effect = combineEffects(effects);
  const preserves = preservesDotRepeat ? true : undefined;
  if (accepted !== undefined && pending.length > 0) {
    return { type: "conflict", accepted, pending, effect, preservesDotRepeat: preserves };
  }
  if (accepted !== undefined) return { type: "run", action: accepted };
  if (pending.length > 0) return { type: "handler", handlerEnvs: pending, effect, preservesDotRepeat: preserves };
  return invalidResult ?? { type: "unhandled" };
}

// Merge the pending effects of several combined handler results into one thunk,
// preserving order (async effects chain). Returns [undefined] when there are
// none so the common no-effect case stays allocation-free. In practice at most
// one active handler carries a pending effect.
function combineEffects(effects: readonly PendingEffect[]): PendingEffect | undefined {
  if (effects.length === 0) return undefined;
  if (effects.length === 1) return effects[0];
  return () =>
    effects.reduce<QueuedRunResult<void>>(
      (previous, next) => (isPromiseLike(previous) ? Promise.resolve(previous).then(() => next()) : next()),
      undefined
    );
}

export function run<T>(action: KeyAction<T>): HandleResult<T> {
  return { type: "run", action };
}

export function effect<T>(
  mode: VimMode,
  run: () => QueuedRunResult<T>,
  meta: EffectMeta = {}
): HandleResult<T> {
  return { type: "run", action: { type: "effect", mode, run, ...meta } };
}

// Like [effect], but the target mode is resolved by calling [resolveMode] after
// [run] executes (see [EffectAction.resolveMode]). [mode] is the executor's
// best-guess parser mode while [run] runs.
export function dynamicModeEffect<T>(
  mode: VimMode,
  run: () => QueuedRunResult<T>,
  resolveMode: () => VimMode,
  meta: EffectMeta = {}
): HandleResult<T> {
  return { type: "run", action: { type: "effect", mode, run, resolveMode, ...meta } };
}

export function handler<T>(
  handlerEnvs: readonly HandlerEnv<T>[],
  { effect, preservesDotRepeat }: { effect?: PendingEffect; preservesDotRepeat?: boolean } = {}
): HandleResult<T> {
  return { type: "handler", handlerEnvs, effect, preservesDotRepeat };
}

export function prefixedHandler<T>(
  prefix: string,
  next: Handler<T>,
  increaseDepth = true
): Handler<T> {
  return (key, state) => {
    if (key !== prefix) return unhandled();
    return handler([
      {
        handler: next,
        state: {
          ...cloneHandlerState(state),
          operatorDepth: increaseDepth ? state.operatorDepth + 1 : state.operatorDepth,
        },
      },
    ]);
  };
}

export function unhandled<T>(): HandleResult<T> {
  return { type: "unhandled" };
}

export function invalid<T>(): HandleResult<T> {
  return { type: "invalid" };
}

// Every spelling of the Escape key a handler can see: tests type "escape",
// the VSCode controller emits "<escape>" (see [keyFromEvent]), and `ctrl-[`
// is Vim's escape synonym. A pending waiter that should be cancelled by
// Escape must check this predicate — not one spelling — and return
// [invalid], so the key abandons the chord instead of being committed as
// input.
export function isEscapeKey(key: string): boolean {
  return key === "escape" || key === "<escape>" || key === "ctrl-[";
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}
