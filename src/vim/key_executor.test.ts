import { KeyExecutor } from "./key_executor.js";
import type { KeyExecutorOptions } from "./key_executor.js";
import {
  Handler,
  HandlerEnv,
  HandlerState,
  KeyAction,
  initialHandlerState,
} from "./key_handler.js";
import type { VimMode } from "./state.js";

// These tests exercise the standalone KeyExecutor against synthetic handlers.
// The goal is to pin down the executor's contract in a contained subsystem:
// pending state, ambiguous-chord conflicts, timeout acceptance, suffix replay,
// and ordered execution of queued effects. They intentionally avoid the real
// Vim handlers so the executor's mechanics are tested in isolation.

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isStrictPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length < full.length && prefix.every((key, index) => key === full[index]);
}

type Binding = { chord: readonly string[]; label: string; mode?: VimMode };

/**
 * A handler that recognizes a fixed set of key chords. It mirrors how a real
 * finite-chord handler reports `run`/`handler`/`conflict`/`invalid`/`unhandled`:
 *
 * - exact match with a longer candidate still possible -> `conflict`
 * - exact match with nothing longer -> `run`
 * - no exact match but a longer candidate -> `handler` (keep waiting)
 * - mid-chord dead end -> `invalid`
 * - first key matches nothing -> `unhandled`
 */
function chordHandler(
  bindings: readonly Binding[],
  log: string[],
  prefix: readonly string[] = []
): Handler<void> {
  const action = (binding: Binding): KeyAction<void> => ({
    type: "effect",
    mode: binding.mode ?? "normal",
    run: () => {
      log.push(binding.label);
    },
  });

  return (key, state) => {
    const keys = [...prefix, key];
    const exact = bindings.find(binding => sameKeys(binding.chord, keys));
    const hasLonger = bindings.some(binding => isStrictPrefix(keys, binding.chord));
    const nextEnv = (): HandlerEnv<void> => ({
      handler: chordHandler(bindings, log, keys),
      state,
    });

    if (exact !== undefined && hasLonger) {
      return { type: "conflict", accepted: action(exact), pending: [nextEnv()] };
    }
    if (exact !== undefined) return { type: "run", action: action(exact) };
    if (hasLonger) return { type: "handler", handlerEnvs: [nextEnv()] };
    if (prefix.length > 0) return { type: "invalid" };
    return { type: "unhandled" };
  };
}

function singleHandlerOptions(
  handler: Handler<void>,
  extra: Omit<KeyExecutorOptions, "handlersForState"> = {}
): KeyExecutorOptions {
  return {
    handlersForState: (state: HandlerState) => [{ handler, state }],
    ...extra,
  };
}

/** Flush the microtask + immediate queue so queued effects have run. */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

type CapturedTimer = { callback: () => void } | undefined;

function timerHarness(): {
  fire: () => void;
  pending: () => boolean;
  options: Pick<KeyExecutorOptions, "timeoutMs" | "setTimeout" | "clearTimeout">;
} {
  let captured: CapturedTimer;
  return {
    fire: () => {
      const timer = captured;
      if (timer === undefined) throw new Error("no timer scheduled");
      captured = undefined;
      timer.callback();
    },
    pending: () => captured !== undefined,
    options: {
      timeoutMs: 1000,
      setTimeout: (callback: () => void) => {
        captured = { callback };
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {
        captured = undefined;
      },
    },
  };
}

describe("KeyExecutor", () => {
  it("runs an effect action for a complete chord", async () => {
    const log: string[] = [];
    const executor = new KeyExecutor(
      singleHandlerOptions(chordHandler([{ chord: ["x"], label: "X" }], log))
    );

    expect(executor.handle("x")).toBe(true);
    await flush();
    expect(log).toEqual(["X"]);
  });

  it("returns false for a key no handler claims", async () => {
    const log: string[] = [];
    const executor = new KeyExecutor(
      singleHandlerOptions(chordHandler([{ chord: ["x"], label: "X" }], log))
    );

    expect(executor.handle("z")).toBe(false);
    await flush();
    expect(log).toEqual([]);
  });

  it("stays pending across a multi-key chord then runs", async () => {
    const log: string[] = [];
    const executor = new KeyExecutor(
      singleHandlerOptions(chordHandler([{ chord: ["g", "g"], label: "GG" }], log))
    );

    expect(executor.handle("g")).toBe(true);
    expect(executor.currentHandlers().length).toBe(1);
    expect(executor.handle("g")).toBe(true);
    await flush();
    expect(log).toEqual(["GG"]);
  });

  describe("ambiguous chords", () => {
    const bindings: readonly Binding[] = [
      { chord: ["g"], label: "G" },
      { chord: ["g", "g"], label: "GG" },
    ];

    it("accepts the shorter chord when the timeout fires", async () => {
      const log: string[] = [];
      const timer = timerHarness();
      const executor = new KeyExecutor(
        singleHandlerOptions(chordHandler(bindings, log), timer.options)
      );

      executor.handle("g");
      expect(executor.pendingConflict()).toBeDefined();
      expect(timer.pending()).toBe(true);

      timer.fire();
      await flush();
      expect(log).toEqual(["G"]);
      expect(executor.pendingConflict()).toBeUndefined();
    });

    it("prefers the longer chord when the next key disambiguates it", async () => {
      const log: string[] = [];
      const timer = timerHarness();
      const executor = new KeyExecutor(
        singleHandlerOptions(chordHandler(bindings, log), timer.options)
      );

      executor.handle("g");
      executor.handle("g");
      await flush();
      expect(log).toEqual(["GG"]);
    });

    it("accepts the shorter chord and replays the disambiguating key", async () => {
      const log: string[] = [];
      const timer = timerHarness();
      const executor = new KeyExecutor(
        singleHandlerOptions(
          chordHandler([...bindings, { chord: ["x"], label: "X" }], log),
          timer.options
        )
      );

      executor.handle("g");
      executor.handle("x");
      await flush();
      // The pending `gg` branch dies on `x`, so the accepted `g` runs and the
      // buffered `x` is replayed through fresh handlers.
      expect(log).toEqual(["G", "X"]);
    });

    it("buffers a multi-key suffix across a chord gap and replays it", async () => {
      const log: string[] = [];
      const timer = timerHarness();
      // `a` is accepted immediately, but `abc` keeps the branch alive across the
      // `ab` gap. Typing `a b x` should run `a`, then replay `b` and `x`.
      const executor = new KeyExecutor(
        singleHandlerOptions(
          chordHandler(
            [
              { chord: ["a"], label: "A" },
              { chord: ["a", "b", "c"], label: "ABC" },
              { chord: ["b"], label: "B" },
              { chord: ["x"], label: "X" },
            ],
            log
          ),
          timer.options
        )
      );

      executor.handle("a");
      executor.handle("b");
      executor.handle("x");
      await flush();
      expect(log).toEqual(["A", "B", "X"]);
    });

    it("lets each longer match supersede the previous accepted chord", async () => {
      const log: string[] = [];
      const timer = timerHarness();
      const executor = new KeyExecutor(
        singleHandlerOptions(
          chordHandler(
            [
              { chord: ["a"], label: "A" },
              { chord: ["a", "b"], label: "AB" },
              { chord: ["a", "b", "c"], label: "ABC" },
              { chord: ["a", "b", "c", "d"], label: "ABCD" },
            ],
            log
          ),
          timer.options
        )
      );

      executor.handle("a");
      executor.handle("b");
      executor.handle("c");
      timer.fire();
      await flush();
      // After `abc` the accepted branch is `abc`, not the earlier `a`/`ab`.
      expect(log).toEqual(["ABC"]);
    });
  });

  describe("composite actions", () => {
    it("runs sequence actions in order", async () => {
      const log: string[] = [];
      const effect = (label: string): KeyAction<void> => ({
        type: "effect",
        mode: "normal",
        run: () => {
          log.push(label);
        },
      });
      const handler: Handler<void> = key =>
        key === "s"
          ? {
              type: "run",
              action: { type: "sequence", mode: "normal", actions: [effect("A"), effect("B")] },
            }
          : { type: "unhandled" };

      const executor = new KeyExecutor(singleHandlerOptions(handler));
      executor.handle("s");
      await flush();
      expect(log).toEqual(["A", "B"]);
    });

    it("re-dispatches keys actions through the executor", async () => {
      const log: string[] = [];
      const emitter: Handler<void> = key =>
        key === "r"
          ? {
              type: "run",
              action: {
                type: "keys",
                mode: "normal",
                keys: [
                  { key: "x", allowRemap: false },
                  { key: "y", allowRemap: false },
                ],
              },
            }
          : { type: "unhandled" };
      const chords = chordHandler(
        [
          { chord: ["x"], label: "X" },
          { chord: ["y"], label: "Y" },
        ],
        log
      );

      const executor = new KeyExecutor({
        handlersForState: (state: HandlerState) => [
          { handler: emitter, state },
          { handler: chords, state },
        ],
      });
      executor.handle("r");
      await flush();
      expect(log).toEqual(["X", "Y"]);
    });

    it("hands command actions to executeCommand", () => {
      const executeCommand = jest.fn();
      const handler: Handler<void> = key =>
        key === "c"
          ? {
              type: "run",
              action: { type: "commands", mode: "normal", commands: ["editor.action.foo"] },
            }
          : { type: "unhandled" };

      const executor = new KeyExecutor(singleHandlerOptions(handler, { executeCommand }));
      executor.handle("c");
      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(executeCommand).toHaveBeenCalledWith("editor.action.foo");
    });
  });

  describe("effect queue", () => {
    it("runs queued effects strictly in order even when async", async () => {
      const log: string[] = [];
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>(resolve => {
        releaseFirst = resolve;
      });

      const handler: Handler<void> = key => {
        if (key === "1") {
          return {
            type: "run",
            action: {
              type: "effect",
              mode: "normal",
              run: async () => {
                await firstGate;
                log.push("first");
              },
            },
          };
        }
        if (key === "2") {
          return {
            type: "run",
            action: {
              type: "effect",
              mode: "normal",
              run: () => {
                log.push("second");
              },
            },
          };
        }
        return { type: "unhandled" };
      };

      const executor = new KeyExecutor(singleHandlerOptions(handler));
      executor.handle("1");
      executor.handle("2");
      await flush();
      // The second effect must not jump ahead of the still-blocked first.
      expect(log).toEqual([]);

      releaseFirst?.();
      await flush();
      expect(log).toEqual(["first", "second"]);
    });

    it("keeps draining the queue after an effect throws", async () => {
      const log: string[] = [];
      const errors: unknown[] = [];
      const handler: Handler<void> = key => {
        if (key === "boom") {
          return {
            type: "run",
            action: {
              type: "effect",
              mode: "normal",
              run: () => {
                throw new Error("boom");
              },
            },
          };
        }
        if (key === "ok") {
          return {
            type: "run",
            action: {
              type: "effect",
              mode: "normal",
              run: () => {
                log.push("ok");
              },
            },
          };
        }
        return { type: "unhandled" };
      };

      const executor = new KeyExecutor(
        singleHandlerOptions(handler, {
          log: { error: (_message, error) => errors.push(error) },
        })
      );
      executor.handle("boom");
      executor.handle("ok");
      await flush();
      expect(log).toEqual(["ok"]);
      expect(errors.length).toBe(1);
    });
  });

  describe("reset", () => {
    it("clears pending handlers and conflicts", async () => {
      const log: string[] = [];
      const timer = timerHarness();
      const executor = new KeyExecutor(
        singleHandlerOptions(
          chordHandler(
            [
              { chord: ["g"], label: "G" },
              { chord: ["g", "g"], label: "GG" },
            ],
            log
          ),
          timer.options
        )
      );

      executor.handle("g");
      expect(executor.pendingConflict()).toBeDefined();

      executor.reset();
      expect(executor.pendingConflict()).toBeUndefined();
      expect(timer.pending()).toBe(false);

      // A fresh `g` starts a brand new conflict rather than resolving the old one.
      executor.handle("g");
      timer.fire();
      await flush();
      expect(log).toEqual(["G"]);
    });

    it("rebuilds default handlers for the target mode", () => {
      const executor = new KeyExecutor(
        singleHandlerOptions(chordHandler([{ chord: ["x"], label: "X" }], []))
      );
      executor.reset("visual");
      expect(executor.currentState().mode).toBe("visual");
    });
  });

  it("starts from the provided initial state", () => {
    const executor = new KeyExecutor(
      singleHandlerOptions(chordHandler([], [])),
      { ...initialHandlerState, mode: "insert" }
    );
    expect(executor.currentState().mode).toBe("insert");
  });

  describe("redispatch and allowRemap", () => {
    it("reports false for a key no handler claims", () => {
      const executor = new KeyExecutor(
        singleHandlerOptions(chordHandler([{ chord: ["x"], label: "X" }], []))
      );

      expect(executor.handle("z")).toBe(false);
    });

    it("routes emitted keys through the owner redispatch with per-key allowRemap", () => {
      const redispatched: { key: string; allowRemap: boolean }[] = [];
      // On `x`, emit `d` (non-recursive) then `e` (recursive). The emitted keys
      // go back through the owner pipeline rather than the executor directly.
      const emitHandler: Handler<void> = (key) => {
        if (key !== "x") return { type: "unhandled" };
        return {
          type: "run",
          action: {
            type: "keys",
            mode: "normal",
            keys: [
              { key: "d", allowRemap: false },
              { key: "e", allowRemap: true },
            ],
          },
        };
      };
      const executor = new KeyExecutor(
        singleHandlerOptions(emitHandler, {
          redispatch: (key, allowRemap) => redispatched.push({ key, allowRemap }),
        })
      );

      expect(executor.handle("x")).toBe(true);
      expect(redispatched).toEqual([
        { key: "d", allowRemap: false },
        { key: "e", allowRemap: true },
      ]);
    });

    it("replays ambiguous-conflict suffix keys through the owner redispatch", async () => {
      const log: string[] = [];
      const redispatched: string[] = [];
      const timer = timerHarness();
      // `g` is an exact match with a longer `gg` candidate -> conflict. Typing a
      // non-matching key accepts the shorter `g` and replays the extra key.
      const executor = new KeyExecutor(
        singleHandlerOptions(
          chordHandler(
            [
              { chord: ["g"], label: "G" },
              { chord: ["g", "g"], label: "GG" },
            ],
            log
          ),
          { ...timer.options, redispatch: key => redispatched.push(key) }
        )
      );

      executor.handle("g");
      executor.handle("x");
      await flush();
      expect(log).toEqual(["G"]);
      expect(redispatched).toEqual(["x"]);
    });

    it("threads allowRemap into handler state for the current dispatch", () => {
      const seen: boolean[] = [];
      const recordingHandler: Handler<void> = (_key, state) => {
        seen.push(state.allowRemap);
        return { type: "unhandled" };
      };
      const executor = new KeyExecutor(singleHandlerOptions(recordingHandler));

      executor.handle("a", true);
      executor.handle("b", false);
      expect(seen).toEqual([true, false]);
    });
  });
});
