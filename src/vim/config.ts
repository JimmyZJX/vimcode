// VSCodeVim compatibility reference:
// - source: VSCodeVim `src/configuration/iconfiguration.ts` `IKeyRemapping`
// - translated concepts: leader normalization and mode-specific key remapping
// - intentional differences: this is a focused compatibility layer, not a full vimrc
//   remapper. It supports exact `before` -> `after` / `commands` mappings first.

import { VimMode } from "./state.js";

export type VimRemapMode = "normal" | "insert" | "visual" | "visualLine" | "visualBlock" | "operatorPending";

export type VimCommandMapping = string | { command: string; args?: unknown | unknown[] };
export type RemapWhenEvaluator = (when: string | undefined) => boolean;

const alwaysActiveRemapWhen: RemapWhenEvaluator = () => true;

export type VimKeyRemapping = {
  before: readonly string[];
  after?: readonly string[];
  commands?: readonly VimCommandMapping[];
  silent?: boolean;
  recursive?: boolean;
  when?: string;
};

export type RawVimConfiguration = Record<string, unknown>;

export const NoopKey = "<nop>";
export const RemapTimeoutKey = "<TimeoutFinished>";

export type VimConfiguration = {
  leader: string;
  normalModeKeyBindings: readonly VimKeyRemapping[];
  normalModeKeyBindingsNonRecursive: readonly VimKeyRemapping[];
  insertModeKeyBindings: readonly VimKeyRemapping[];
  insertModeKeyBindingsNonRecursive: readonly VimKeyRemapping[];
  visualModeKeyBindings: readonly VimKeyRemapping[];
  visualModeKeyBindingsNonRecursive: readonly VimKeyRemapping[];
  operatorPendingModeKeyBindings: readonly VimKeyRemapping[];
  operatorPendingModeKeyBindingsNonRecursive: readonly VimKeyRemapping[];
  handleKeys: Readonly<Record<string, boolean>>;
  useCtrlKeys: boolean;
  useSystemClipboard: boolean;
  timeout: number;
  visualMultilineInsert: boolean;
  easymotion: boolean;
  easymotionKeys: string;
  easymotionJumpToAnywhereRegex: string;
};

export const defaultVimConfiguration: VimConfiguration = {
  leader: "\\",
  normalModeKeyBindings: [],
  normalModeKeyBindingsNonRecursive: [],
  insertModeKeyBindings: [],
  insertModeKeyBindingsNonRecursive: [],
  visualModeKeyBindings: [],
  visualModeKeyBindingsNonRecursive: [],
  operatorPendingModeKeyBindings: [],
  operatorPendingModeKeyBindingsNonRecursive: [],
  handleKeys: {},
  useCtrlKeys: true,
  useSystemClipboard: false,
  timeout: 1000,
  visualMultilineInsert: true,
  easymotion: false,
  easymotionKeys: "hklyuiopnm,qwertzxcvbasdgjf;",
  easymotionJumpToAnywhereRegex: "\\b[A-Za-z0-9]|[A-Za-z0-9]\\b|_.|#.|[a-z][A-Z]",
};

export function layeredConfigValue(config: RawVimConfiguration, option: string): unknown {
  return layeredConfigValueFromSources([config], option);
}

export function layeredConfigValueFromSources(configs: readonly RawVimConfiguration[], option: string): unknown {
  const layers = configs.flatMap((config, sourceIndex) =>
    Object.keys(config)
      .filter(key => key.startsWith(`${option}__`))
      .map(key => ({
        suffix: key.slice(option.length + 2),
        sourceIndex,
        value: config[key],
      })));
  layers.sort((a, b) => compareStrings(a.suffix, b.suffix) || a.sourceIndex - b.sourceIndex);
  const values = [
    ...layers.map(layer => layer.value),
    ...configs.map(config => config[option]).filter(value => value !== undefined),
  ];

  if (values.some(Array.isArray)) {
    return values.filter(Array.isArray).flat();
  }

  if (values.some(isPlainObject)) {
    return Object.assign({}, ...values.filter(isPlainObject));
  }

  return values[values.length - 1];
}

export function mergeVimConfiguration(config: Partial<VimConfiguration> = {}): VimConfiguration {
  return {
    ...defaultVimConfiguration,
    ...config,
    leader: normalizeKey(config.leader ?? defaultVimConfiguration.leader, defaultVimConfiguration.leader),
    handleKeys: normalizeHandleKeys(config.handleKeys ?? defaultVimConfiguration.handleKeys),
    timeout: normalizeTimeout(config.timeout ?? defaultVimConfiguration.timeout),
  };
}

function normalizeTimeout(timeout: number): number {
  return Number.isFinite(timeout) ? Math.max(0, timeout) : defaultVimConfiguration.timeout;
}

function normalizeHandleKeys(handleKeys: Readonly<Record<string, boolean>>): Readonly<Record<string, boolean>> {
  return Object.fromEntries(Object.entries(handleKeys).map(([key, value]) => [normalizeKey(key, defaultVimConfiguration.leader), value]));
}

export type NormalizedRemapping = {
  before: readonly string[];
  after: readonly string[];
  commands: readonly VimCommandMapping[];
  recursive: boolean;
  when?: string;
};

export type AmbiguousRemapConflict = {
  mode: VimRemapMode;
  shorter: readonly string[];
  longer: readonly string[];
};

export class RemapResolver {
  private pendingKeys: string[] = [];
  private pendingAmbiguousMapping: NormalizedRemapping | undefined;
  private readonly mappingsByMode: Record<VimRemapMode, readonly NormalizedRemapping[]>;
  private readonly conflicts: readonly AmbiguousRemapConflict[];

  constructor(private readonly config: VimConfiguration) {
    this.mappingsByMode = {
      normal: normalizeRemappings(config.leader, config.normalModeKeyBindings, true)
        .concat(normalizeRemappings(config.leader, config.normalModeKeyBindingsNonRecursive, false)),
      insert: normalizeRemappings(config.leader, config.insertModeKeyBindings, true)
        .concat(normalizeRemappings(config.leader, config.insertModeKeyBindingsNonRecursive, false)),
      visual: normalizeRemappings(config.leader, config.visualModeKeyBindings, true)
        .concat(normalizeRemappings(config.leader, config.visualModeKeyBindingsNonRecursive, false)),
      visualLine: normalizeRemappings(config.leader, config.visualModeKeyBindings, true)
        .concat(normalizeRemappings(config.leader, config.visualModeKeyBindingsNonRecursive, false)),
      visualBlock: normalizeRemappings(config.leader, config.visualModeKeyBindings, true)
        .concat(normalizeRemappings(config.leader, config.visualModeKeyBindingsNonRecursive, false)),
      operatorPending: normalizeRemappings(config.leader, config.operatorPendingModeKeyBindings, true)
        .concat(normalizeRemappings(config.leader, config.operatorPendingModeKeyBindingsNonRecursive, false)),
    };
    this.conflicts = ambiguousRemapConflicts(this.mappingsByMode);
  }

  isPending(): boolean {
    return this.pendingKeys.length > 0;
  }

  hasMappings(mode: VimRemapMode, whenEvaluator: RemapWhenEvaluator = alwaysActiveRemapWhen): boolean {
    return this.activeMappings(mode, whenEvaluator).length > 0;
  }

  hasMappingStartingWith(mode: VimRemapMode, key: string, whenEvaluator: RemapWhenEvaluator = alwaysActiveRemapWhen): boolean {
    return this.activeMappings(mode, whenEvaluator).some(mapping => mapping.before[0] === normalizeKey(key, this.config.leader));
  }

  ambiguousConflicts(): readonly AmbiguousRemapConflict[] {
    return this.conflicts;
  }

  handleKeyOverride(key: string): boolean | undefined {
    return this.config.handleKeys[normalizeKey(key, this.config.leader)];
  }

  pendingChord(): string {
    return this.pendingKeys.join(" ");
  }

  pendingInsertText(): string | undefined {
    const key = this.pendingKeys[this.pendingKeys.length - 1];
    if (key === undefined) return undefined;
    if (key === "space") return " ";
    return key.length === 1 ? key : undefined;
  }

  clearPending(): void {
    this.pendingKeys = [];
    this.pendingAmbiguousMapping = undefined;
  }

  handleKey(mode: VimRemapMode, key: string, whenEvaluator: RemapWhenEvaluator = alwaysActiveRemapWhen): RemapResolution {
    if (key === RemapTimeoutKey) {
      return this.handleTimeout(whenEvaluator);
    }

    const keys = [...this.pendingKeys, key];
    const mappings = this.activeMappings(mode, whenEvaluator);
    const exact = findLast(mappings, mapping => sameKeys(mapping.before, keys));
    const hasLongerMatch = mappings.some(mapping => isPrefix(keys, mapping.before) && !sameKeys(mapping.before, keys));

    if (exact !== undefined) {
      if (hasLongerMatch) {
        this.pendingKeys = keys;
        this.pendingAmbiguousMapping = exact;
        return { kind: "pending", chord: keys.join(" ") };
      }
      this.clearPending();
      return { kind: "matched", mapping: exact };
    }

    if (hasLongerMatch) {
      this.pendingKeys = keys;
      this.pendingAmbiguousMapping = undefined;
      return { kind: "pending", chord: keys.join(" ") };
    }

    if (this.pendingKeys.length > 0) {
      const ambiguousMapping = this.pendingAmbiguousMapping;
      this.clearPending();
      if (ambiguousMapping !== undefined) {
        return { kind: "matchedWithReplay", mapping: ambiguousMapping, keys: keys.slice(ambiguousMapping.before.length) };
      }
      return { kind: "replay", keys };
    }

    return { kind: "noMatch" };
  }

  private handleTimeout(whenEvaluator: RemapWhenEvaluator): RemapResolution {
    const keys = this.pendingKeys;
    const ambiguousMapping = this.pendingAmbiguousMapping;
    this.clearPending();
    if (keys.length === 0) return { kind: "handled" };
    if (ambiguousMapping !== undefined && this.mappingIsActive(ambiguousMapping, whenEvaluator)) {
      return { kind: "matched", mapping: ambiguousMapping };
    }
    return { kind: "replay", keys };
  }

  private activeMappings(mode: VimRemapMode, whenEvaluator: RemapWhenEvaluator): readonly NormalizedRemapping[] {
    return this.mappingsByMode[mode].filter(mapping => this.mappingIsActive(mapping, whenEvaluator));
  }

  private mappingIsActive(mapping: NormalizedRemapping, whenEvaluator: RemapWhenEvaluator): boolean {
    return whenEvaluator(mapping.when);
  }
}

export type RemapResolution =
  | { kind: "pending"; chord: string }
  | { kind: "matched"; mapping: NormalizedRemapping }
  | { kind: "matchedWithReplay"; mapping: NormalizedRemapping; keys: readonly string[] }
  | { kind: "replay"; keys: readonly string[] }
  | { kind: "handled" }
  | { kind: "noMatch" };

export function remapModeForVimMode(mode: VimMode["kind"], { operatorPending }: { operatorPending: boolean }): VimRemapMode {
  if (operatorPending) return "operatorPending";
  switch (mode) {
    case "insert":
      return "insert";
    case "visual":
      return "visual";
    case "visualLine":
      return "visualLine";
    case "visualBlock":
      return "visualBlock";
    case "normal":
    case "replace":
    case "search":
    case "command":
    case "select":
      return "normal";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizeRemappings(leader: string, mappings: readonly VimKeyRemapping[], recursive: boolean): readonly NormalizedRemapping[] {
  return mappings.map(mapping => ({
    before: mapping.before.map(key => normalizeKey(key, leader)),
    after: (mapping.after ?? []).map(key => normalizeKey(key, leader)),
    commands: mapping.commands ?? [],
    recursive: mapping.recursive ?? recursive,
    when: mapping.when,
  })).filter(mapping => mapping.before.length > 0 && (mapping.after.length > 0 || mapping.commands.length > 0));
}

export function normalizeKey(key: string, leader: string): string {
  if (key.length === 1) return key;
  let normalized = key.toLowerCase();
  if (!normalized.startsWith("<") || !normalized.endsWith(">")) normalized = `<${normalized}>`;

  if (normalized === "<leader>") return leader;
  if (normalized === "<nop>") return NoopKey;
  if (normalized === "<space>") return "space";
  if (normalized === "<cr>" || normalized === "<enter>" || normalized === "<return>") return "enter";
  if (normalized === "<esc>" || normalized === "<escape>") return "<escape>";
  if (normalized === "<bs>" || normalized === "<backspace>") return "backspace";
  if (normalized === "<del>" || normalized === "<delete>") return "delete";
  if (normalized === "<ins>" || normalized === "<insert>") return "insert";
  if (normalized === "<tab>") return "tab";
  if (normalized === "<left>") return "left";
  if (normalized === "<right>") return "right";
  if (normalized === "<up>") return "up";
  if (normalized === "<down>") return "down";
  if (normalized === "<home>") return "home";
  if (normalized === "<end>") return "end";
  if (normalized === "<pageup>") return "pageup";
  if (normalized === "<pagedown>") return "pagedown";

  const ctrl = /^<c(?:trl)?-(.+)>$/.exec(normalized);
  if (ctrl !== null) return `ctrl-${normalizeModifierKey(ctrl[1])}`;

  const shift = /^<s(?:hift)?-([a-z])>$/.exec(normalized);
  if (shift !== null) return shift[1].toUpperCase();

  return key;
}

function normalizeModifierKey(key: string): string {
  switch (key) {
    case "[":
      return "[";
    case "space":
      return "space";
    case "pageup":
      return "pageup";
    case "pagedown":
      return "pagedown";
    default:
      return key;
  }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length < full.length && prefix.every((key, index) => key === full[index]);
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}

function ambiguousRemapConflicts(
  mappingsByMode: Record<VimRemapMode, readonly NormalizedRemapping[]>
): readonly AmbiguousRemapConflict[] {
  const conflicts: AmbiguousRemapConflict[] = [];
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
