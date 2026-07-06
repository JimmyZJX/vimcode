// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `test::neovim_connection::NeovimConnection`
// - translated concepts: set marked state, feed keystrokes to Neovim, read marked state back
// - intentional differences: this first version runs one short-lived `nvim --headless`
//   process per comparison instead of maintaining an embedded RPC session or recording fixtures.

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { ParsedMarkedText, encodeMarkedText, parseMarkedText } from "./marked_text.js";

export type NeovimMode = "normal" | "insert" | "visual" | "visualLine" | "visualBlock" | "replace";

export type NeovimState = {
  mode: NeovimMode;
  markedText: string;
  registers?: Record<string, string>;
};

export function neovimAvailable(): boolean {
  const result = spawnSync("nvim", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

export function runNeovim({
  initialState,
  keys,
  readRegisters = [],
  setup = [],
}: {
  initialState: string;
  keys: readonly string[];
  readRegisters?: readonly string[];
  // Ex commands (e.g. `set textwidth=20`) run after the buffer is populated
  // and before the keys are fed; used when recording option-dependent
  // fixtures.
  setup?: readonly string[];
}): NeovimState {
  const parsed = parseMarkedText(initialState);
  const input = keys.map(keyToNeovimInput).join("");
  const script = luaScript(parsed, input, readRegisters, setup);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vimcode-nvim-"));
  const scriptPath = path.join(dir, "script.lua");
  fs.writeFileSync(scriptPath, script);

  try {
    const result = spawnSync(
      "nvim",
      ["--headless", "--clean", "-n", "-m", "-i", "NONE", "+set nomore", `+luafile ${scriptPath}`, "+qa!"],
      { encoding: "utf8" }
    );

    if (result.status !== 0) {
      throw new Error(`nvim failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    const line = result.stdout
      .split("\n")
      .find((stdoutLine) => stdoutLine.startsWith("NVIM_RESULT:"));
    if (line === undefined) {
      throw new Error(`nvim did not print result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    const raw = JSON.parse(line.slice("NVIM_RESULT:".length)) as {
      mode: string;
      lines: string[];
      cursor: [number, number];
      registers?: Record<string, string>;
    };
    return {
      mode: parseNeovimMode(raw.mode),
      markedText: encodeMarkedText({
        text: raw.lines.join("\n"),
        row: raw.cursor[0] - 1,
        column: raw.cursor[1],
        mode: parseNeovimMode(raw.mode),
      }),
      registers: raw.registers,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function luaScript(parsed: ParsedMarkedText, input: string, readRegisters: readonly string[], setup: readonly string[] = []): string {
  return `
local lines = ${luaStringArray(parsed.text.split("\n"))}
vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
-- The marked-text column is a UTF-16 index; Neovim's cursor wants bytes.
local start_line = lines[${parsed.row + 1}] or ""
local byteindex_ok, start_col = pcall(vim.str_byteindex, start_line, ${parsed.column}, true)
vim.api.nvim_win_set_cursor(0, { ${parsed.row + 1}, byteindex_ok and start_col or ${parsed.column} })
for _, command in ipairs(${luaStringArray(setup)}) do
  vim.cmd(command)
end
local keys = vim.api.nvim_replace_termcodes(${JSON.stringify(input)}, true, false, true)
vim.api.nvim_feedkeys(keys, "xt", false)
local registers = {}
for _, register in ipairs(${luaStringArray(readRegisters)}) do
  registers[register] = vim.fn.getreg(register)
end
-- Report the cursor column as a UTF-16 index (what the JS side uses), not
-- Neovim's byte index — they diverge on any non-ASCII line.
local cursor = vim.api.nvim_win_get_cursor(0)
local cursor_line = vim.api.nvim_buf_get_lines(0, cursor[1] - 1, cursor[1], false)[1] or ""
local utf16_ok, _, cursor_utf16 = pcall(vim.str_utfindex, cursor_line, cursor[2])
local result = {
  mode = vim.api.nvim_get_mode().mode,
  lines = vim.api.nvim_buf_get_lines(0, 0, -1, false),
  cursor = { cursor[1], utf16_ok and cursor_utf16 or cursor[2] },
  registers = registers,
}
io.stdout:write("NVIM_RESULT:" .. vim.fn.json_encode(result) .. "\\n")
vim.cmd("qa!")
`;
}

function luaStringArray(values: readonly string[]): string {
  return `{ ${values.map((value) => JSON.stringify(value)).join(", ")} }`;
}

function keyToNeovimInput(key: string): string {
  switch (key) {
    case "<escape>":
    case "escape":
      return "<Esc>";
    case "ctrl-[":
      return "<C-[>";
    case "enter":
    case "\n":
      return "<CR>";
    case "backspace":
      return "<BS>";
    case "space":
      return " ";
    case "left":
      return "<Left>";
    case "right":
      return "<Right>";
    case "up":
      return "<Up>";
    case "down":
      return "<Down>";
    default:
      break;
  }

  const shiftMatch = /^shift-(.)$/.exec(key);
  if (shiftMatch !== null) return shiftMatch[1].toUpperCase();

  const ctrlMatch = /^ctrl-(.)$/.exec(key);
  if (ctrlMatch !== null) return `<C-${ctrlMatch[1]}>`;

  return key;
}

function parseNeovimMode(mode: string): NeovimMode {
  switch (mode) {
    case "n":
      return "normal";
    case "i":
      return "insert";
    case "v":
      return "visual";
    case "V":
      return "visualLine";
    case "\x16":
      return "visualBlock";
    case "R":
      return "replace";
    default:
      throw new Error(`unexpected nvim mode: ${mode}`);
  }
}
