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

type ChordResult<I, O> =
	| { type: "submenu" }
	| { type: "action"; action: Action<I, O> };

interface ChordState<I, O> {
	reset(): void;
	onKey(key: string): ChordResult<I, O>;
}

type ChordMenuEntry<I, O> =
	| { type: "submenu"; menu: Record<string, ChordMenuEntry<I, O>> }
	| { type: "action"; action: Action<I, O> }
	| null;

class ChordMenu<I, O> extends ChordState<I, O> {
	current: null | Record<string, ChordMenuEntry<I, O>> = null;

	constructor(readonly menu: Record<string, ChordMenuEntry<I, O>>) {}

	reset() {
		this.current = this.menu;
	}

	onKey(key: string) {
		if (this.current === null) return null;
		const entry = this.current[key];
		if (!entry) {
			this.current = null;
			return null;
		}
		if (entry && entry.type === "submenu") {
			this.current = entry.menu;
			return { type: "submenu" };
		}
		this.current = this.menu;
		return entry;
	}
}

class WrapperChord<I, O> extends ChordState<I, O> {
	constructor(
		readonly inner: ChordState<InnerI, InnerO>,
		readonly mapInput: (input: I) => InnerI,
		readonly mapOutput: (output: InnerO) => O
	) {}
	reset() {
		inner.reset();
	}
	onKey(key: string) {
		const r = inner.onKey(key);
		if (r && r.type === "action") {
			return {
				type: "action",
				action: (editor, env, input) =>
					mapOutput(
						r.action(
							editor,
							env,
							mapInput(input)
						)
					),
			};
		}
		return r;
	}
}

class MultiChord<I, O> extends ChordState<I, O> {
	constructor(readonly multi: ChordState<I, O>) {}

	reset() {
		for (const cs of multi) {
			cs.reset();
		}
	}

	onKey(key: string) {
		const any = null;
		for (const cs of multi) {
			const r = cs.onKey(key);
			// TODO warn if some action overrides other menu
			if (r && r.type === "action") return r;
			if (r) any = r;
		}
		return any;
	}
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

export type ChordKeys<I, O> = Record<string, ChordEntry<I, O> | undefined>;

// TODO use `null` to immediately fail
export type ChordMenuImpl<I, O> =
	| { type: "keys"; keys: Record<string, ChordEntry<I, O> | undefined> }
	| {
			type: "fn";
			fn: Action<
				{ key: string; input: I },
				ChordEntry<I, O> | undefined
			>;
	  };

export type ChordMenu<I, O> =
	| { type: "map"; mapper: ChordMenuMapper<I, O> }
	| { type: "impl"; impl: ChordMenuImpl<I, O> }
	| { type: "multi"; menus: ChordMenu<I, O>[] };

type ChordMenuMapper<I, O> = <R>(
	k: <I_, O_>(
		mapInput: (input: I) => I_,
		inner: ChordMenu<I_, O_>,
		mapOutput: Action<{ input: I; output: O_ }, O>
	) => R
) => R;

export function mapChordMenu<I, I_, O_, O>(
	mapInput: (input: I) => I_,
	inner: ChordMenu<I_, O_>,
	mapOutput: Action<{ input: I; output: O_ }, O>
): ChordMenu<I, O> {
	return { type: "map", mapper: (k) => k(mapInput, inner, mapOutput) };
}

function followKeyGeneric<I, I_, O_, O>(
	menu: ChordMenu<I_, O_>,
	input: I,
	mapInput: (input: I) => I_,
	mapOutput: Action<{ input: I; output: O_ }, O>,
	key: string,
	editor: Editor,
	env: Env
): ChordEntry<I, O> | undefined {
	if (menu.type === "map") {
		return menu.mapper((mapInput_, inner, mapOutput_) => {
			const mapInp = (input: I) => mapInput_(mapInput(input));
			return followKeyGeneric(
				inner,
				input,
				mapInp,
				(editor, env, { input, output }) =>
					mapOutput(editor, env, {
						input: input,
						output: mapOutput_(
							editor,
							env,
							{
								input: mapInput(
									input
								),
								output,
							}
						),
					}),
				key,
				editor,
				env
			);
		});
	} else if (menu.type === "multi") {
		const entries = menu.menus.flatMap((m) => {
			const entry = followKeyGeneric(
				m,
				input,
				mapInput,
				mapOutput,
				key,
				editor,
				env
			);
			return entry !== undefined ? [entry] : [];
		});

		if (entries.length === 0) return undefined;
		if (entries.length === 1) return entries[0];

		// Multiple entries found - respect first match
		const firstType = entries[0].type;
		if (firstType === "action" || firstType === "delayed") {
			// Actions and delayed actions: return first match
			return entries[0];
		} else {
			// Menus: merge all menus together
			const menus = entries.flatMap((e) =>
				e.type === "menu" ? [e.menu] : []
			);
			return { type: "menu", menu: { type: "multi", menus } };
		}
	} else {
		const impl = menu.impl;
		const entry =
			impl.type === "keys"
				? impl.keys[key]
				: impl.fn(editor, env, {
						key,
						input: mapInput(input),
					});
		if (entry === undefined) {
			return undefined;
		}
		if (entry.type === "action")
			return {
				type: "action",
				action: (editor, env, input) => {
					const rawOutput = entry.action(
						editor,
						env,
						mapInput(input)
					);
					return mapOutput(editor, env, {
						input,
						output: rawOutput,
					});
				},
			};
		if (entry.type === "delayed") {
			return {
				type: "delayed",
				delayed: (k) =>
					entry.delayed((prepare, delayed) =>
						k(
							async (
								editor,
								env,
								input
							) => {
								const delayedInput =
									await prepare(
										editor,
										env,
										mapInput(
											input
										)
									);
								return {
									delayedInput,
									input,
								};
							},
							(
								editor,
								env,
								{
									delayedInput,
									input,
								}
							) => {
								const rawOutput =
									delayed(
										editor,
										env,
										delayedInput
									);
								return mapOutput(
									editor,
									env,
									{
										input,
										output: rawOutput,
									}
								);
							}
						)
					),
			};
		}
		return {
			type: "menu",
			menu: mapChordMenu(mapInput, entry.menu, mapOutput),
		};
	}
}

export function followKey<I, O>(
	chordMenu: ChordMenu<I, O>,
	input: I,
	key: string,
	editor: Editor,
	env: Env
): ChordEntry<I, O> | undefined {
	return followKeyGeneric(
		chordMenu,
		input,
		(i) => i,
		(_editor, _env, { input: _, output }) => output,
		key,
		editor,
		env
	);
}

export type CollapsedChordEntry<I, O> =
	| { type: "menu"; menu: ChordMenuMapper<I, O> }
	| { type: "action"; action: Action<I, O> };

export function simpleKeys<I, O>(
	actions: Record<string, Action<I, O> | undefined>
): ChordKeys<I, O> {
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
		const r = followKey(cur, getInput(), key, editor, env);
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
				const prepared = await prepare(
					editor,
					env,
					getInput()
				);

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
