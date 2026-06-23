// VSCodeVim compatibility reference:
// - source: VSCodeVim `src/configuration/iconfiguration.ts` `IKeyRemapping`
// - translated concepts: leader normalization and mode-specific key remapping
// - intentional differences: this is a focused compatibility layer, not a full vimrc
//   remapper. It supports exact `before` -> `after` / `commands` mappings first.

import type { Handler, HandlerEnv, HandlerState, HandleResult, KeyAction } from "./key_handler.js";
import { cloneHandlerState } from "./key_handler.js";
import { NoopKey, normalizeKey, normalizeRemappings } from "./config.js";
import type { NormalizedRemapping, WhenEvaluator, VimConfiguration, VimRemapMode } from "./config.js";

const alwaysActiveWhenEvaluator: WhenEvaluator = () => true;

export type DebugRemapConflict = {
  mode: VimRemapMode;
  shorter: readonly string[];
  longer: readonly string[];
};

export type Remaps = {
  configuration: VimConfiguration;
  mappingsByMode: Record<VimRemapMode, readonly NormalizedRemapping[]>;
};

type PendingRemap = {
  keys: readonly string[];
  ambiguousMapping: NormalizedRemapping | undefined;
};

export function createRemaps(configuration: VimConfiguration): Remaps {
  const mappingsByMode: Record<VimRemapMode, readonly NormalizedRemapping[]> = {
    normal: normalizeRemappings(configuration.leader, configuration.normalModeKeyBindings, true)
      .concat(normalizeRemappings(configuration.leader, configuration.normalModeKeyBindingsNonRecursive, false)),
    insert: normalizeRemappings(configuration.leader, configuration.insertModeKeyBindings, true)
      .concat(normalizeRemappings(configuration.leader, configuration.insertModeKeyBindingsNonRecursive, false)),
    visual: normalizeRemappings(configuration.leader, configuration.visualModeKeyBindings, true)
      .concat(normalizeRemappings(configuration.leader, configuration.visualModeKeyBindingsNonRecursive, false)),
    visualLine: normalizeRemappings(configuration.leader, configuration.visualModeKeyBindings, true)
      .concat(normalizeRemappings(configuration.leader, configuration.visualModeKeyBindingsNonRecursive, false)),
    visualBlock: normalizeRemappings(configuration.leader, configuration.visualModeKeyBindings, true)
      .concat(normalizeRemappings(configuration.leader, configuration.visualModeKeyBindingsNonRecursive, false)),
    operatorPending: normalizeRemappings(configuration.leader, configuration.operatorPendingModeKeyBindings, true)
      .concat(normalizeRemappings(configuration.leader, configuration.operatorPendingModeKeyBindingsNonRecursive, false)),
  };
  return { configuration, mappingsByMode };
}

export function debugRemapConflicts(remaps: Remaps): readonly DebugRemapConflict[] {
  return debugRemapConflictsFromMappings(remaps.mappingsByMode);
}

export function remapHandler(remaps: Remaps, mode: VimRemapMode): Handler<void> {
  return (key, state) => handleRemapKey(remaps, mode, key, state, { keys: [], ambiguousMapping: undefined });
}

export function hasRemapStartingWith(
  remaps: Remaps,
  mode: VimRemapMode,
  key: string,
  whenEvaluator: WhenEvaluator = alwaysActiveWhenEvaluator
): boolean {
  return remaps.mappingsByMode[mode]
    .filter(mapping => whenEvaluator(mapping.when))
    .some(mapping => mapping.before[0] === normalizeKey(key, remaps.configuration.leader));
}

export function handleKeyOverride(remaps: Remaps, key: string): boolean | undefined {
  return remaps.configuration.handleKeys[normalizeKey(key, remaps.configuration.leader)];
}

export function pendingRemapInsertText(handlerEnvs: readonly HandlerEnv<void>[]): string | undefined {
  const keys = handlerEnvs[0]?.state.remapKeys;
  const key = keys?.[keys.length - 1];
  if (key === undefined) return undefined;
  if (key === "space") return " ";
  return key.length === 1 ? key : undefined;
}

function handleRemapKey(
  remaps: Remaps,
  mode: VimRemapMode,
  key: string,
  state: HandlerState,
  pending: PendingRemap
): HandleResult<void> {
  const keys = [...pending.keys, key];
  const mappings = remaps.mappingsByMode[mode].filter(mapping => state.whenEvaluator(mapping.when));
  const exact = findLast(mappings, mapping => sameKeys(mapping.before, keys));
  const hasLongerMatch = mappings.some(mapping => isPrefix(keys, mapping.before) && !sameKeys(mapping.before, keys));

  if (exact !== undefined) {
    if (hasLongerMatch) {
      return {
        type: "conflict",
        accepted: mappingAction(state, exact),
        pending: [
          {
            handler: (key, handlerState) =>
              handleRemapKey(remaps, mode, key, handlerState, { keys, ambiguousMapping: exact }),
            state: { ...cloneHandlerState(state), remapKeys: keys },
          },
        ],
      };
    }
    return { type: "run", action: mappingAction(state, exact) };
  }

  if (hasLongerMatch) {
    const handlerEnv = {
      handler: (key: string, handlerState: HandlerState) =>
        handleRemapKey(remaps, mode, key, handlerState, {
          keys,
          ambiguousMapping: pending.ambiguousMapping,
        }),
      state: { ...cloneHandlerState(state), remapKeys: keys },
    };
    if (pending.keys.length === 0) {
      return {
        type: "conflict",
        accepted: keysAction(state, keys, { allowRemapForFirstKey: false }),
        pending: [handlerEnv],
      };
    }
    return { type: "handler", handlerEnvs: [handlerEnv] };
  }

  if (pending.keys.length > 0) {
    if (pending.ambiguousMapping !== undefined) {
      // The generic key executor owns replaying the buffered suffix when it is
      // in use. The direct legacy Vim remap path still needs the explicit
      // replay payload returned here until it is migrated onto KeyExecutor.
      return {
        type: "run",
        action: sequenceAction(state, [
          mappingAction(state, pending.ambiguousMapping),
          keysAction(state, keys.slice(pending.ambiguousMapping.before.length), {
            allowRemapForFirstKey: true,
          }),
        ]),
      };
    }
    return { type: "run", action: keysAction(state, keys, { allowRemapForFirstKey: false }) };
  }

  return { type: "unhandled" };
}

function mappingAction(state: HandlerState, mapping: NormalizedRemapping): KeyAction<void> {
  const skipFirstRecursiveKey = mapping.recursive && isPrefixOrEqual(mapping.before, mapping.after);
  return sequenceAction(state, [
    {
      type: "keys",
      mode: state.mode,
      keys: mapping.after
        .filter(key => key !== NoopKey)
        .map((key, index) => ({
          key,
          allowRemap: mapping.recursive && !(skipFirstRecursiveKey && index === 0),
        })),
    },
    { type: "commands", mode: state.mode, commands: mapping.commands },
  ]);
}

function keysAction(
  state: HandlerState,
  keys: readonly string[],
  { allowRemapForFirstKey }: { allowRemapForFirstKey: boolean }
): KeyAction<void> {
  return {
    type: "keys",
    mode: state.mode,
    keys: keys.map((key, index) => ({ key, allowRemap: allowRemapForFirstKey || index > 0 })),
  };
}

function sequenceAction(state: HandlerState, actions: readonly KeyAction<void>[]): KeyAction<void> {
  return { type: "sequence", mode: state.mode, actions };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length < full.length && prefix.every((key, index) => key === full[index]);
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean | undefined): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}

function debugRemapConflictsFromMappings(
  mappingsByMode: Record<VimRemapMode, readonly NormalizedRemapping[]>
): readonly DebugRemapConflict[] {
  const conflicts: DebugRemapConflict[] = [];
  for (const [mode, mappings] of Object.entries(mappingsByMode) as [VimRemapMode, readonly NormalizedRemapping[]][]) {
    for (const shorter of mappings) {
      for (const longer of mappings) {
        if (shorter === longer) continue;
        if (isPrefixOrEqual(shorter.before, longer.before) && shorter.before.length < longer.before.length) {
          conflicts.push({ mode, shorter: shorter.before, longer: longer.before });
        }
      }
    }
  }
  return conflicts;
}

function isPrefixOrEqual(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((key, index) => key === full[index]);
}
