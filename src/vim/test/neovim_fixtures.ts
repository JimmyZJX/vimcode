// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `test::neovim_connection::NeovimData` and
//   `test::neovim_connection::NeovimConnection::{read_test_data, write_test_data}`
// - translated concepts: JSON-lines Neovim operation fixtures
// - intentional differences: fixture files are the Jest test list. They may start with
//   `// DISABLED: <reason>` to keep migrated-but-not-yet-enabled cases in-tree.

import fs from "fs";
import path from "path";
import { NeovimMode, NeovimState } from "./neovim_connection.js";

export type NeovimFixtureEntry = {
  Put: { state: string };
} | {
  Key: string;
} | {
  ReadRegister: { name: string; value: string };
} | {
  Get: { state: string; mode: NeovimMode };
};

export type EnabledNeovimFixture = {
  status: "enabled";
  testCaseId: string;
  file: string;
  entries: readonly NeovimFixtureEntry[];
};

export type DisabledNeovimFixture = {
  status: "disabled";
  testCaseId: string;
  file: string;
  reason: string;
};

export type NeovimFixture = EnabledNeovimFixture | DisabledNeovimFixture;

const testDataDir = path.join(process.cwd(), "src", "vim", "test_data");

export function shouldRecordNeovimFixtures(): boolean {
  return process.env.VIMCODE_RECORD_NEOVIM === "1";
}

export function fixturePath(testCaseId: string): string {
  return path.join(testDataDir, `${sanitizeTestCaseId(testCaseId)}.json`);
}

export function readAllFixtures(): readonly NeovimFixture[] {
  if (!fs.existsSync(testDataDir)) return [];
  return fs
    .readdirSync(testDataDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readFixtureFile(path.join(testDataDir, file)));
}

export function readFixture(testCaseId: string): EnabledNeovimFixture | undefined {
  const fixture = readFixturePath(fixturePath(testCaseId));
  if (fixture === undefined) return undefined;
  if (fixture.status === "disabled") {
    throw new Error(`fixture ${fixture.file} is disabled: ${fixture.reason}`);
  }
  return fixture;
}

export function readFixturePath(file: string): NeovimFixture | undefined {
  if (!fs.existsSync(file)) return undefined;
  return readFixtureFile(file);
}

function readFixtureFile(file: string): NeovimFixture {
  const testCaseId = path.basename(file, ".json");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const disabled = lines.find((line) => line.startsWith("// DISABLED:"));
  if (disabled !== undefined) {
    return {
      status: "disabled",
      testCaseId,
      file,
      reason: disabled.slice("// DISABLED:".length).trim(),
    };
  }

  const entries = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map(parseEntry);

  if (!entries.some((entry) => "Put" in entry) || !entries.some((entry) => "Get" in entry)) {
    throw new Error(`invalid Neovim fixture ${file}: expected Put and Get entries`);
  }

  return { status: "enabled", testCaseId, file, entries };
}

function parseEntry(line: string): NeovimFixtureEntry {
  const entry = JSON.parse(line) as
    | { Put: { state: string } }
    | { Key: string }
    | { ReadRegister: { name: string; value: string } }
    | { Get: { state: string; mode: string } };

  if ("Get" in entry) {
    return { Get: { state: entry.Get.state, mode: normalizeMode(entry.Get.mode) } };
  }
  return entry;
}

export function writeFixture(
  testCaseId: string,
  fixture: { initialState: string; keys: readonly string[]; result: NeovimState }
): void {
  fs.mkdirSync(testDataDir, { recursive: true });
  const entries: NeovimFixtureEntry[] = [
    { Put: { state: fixture.initialState } },
    ...fixture.keys.map((key) => ({ Key: key })),
    ...Object.entries(fixture.result.registers ?? {}).map(([name, value]) => ({
      ReadRegister: { name, value },
    })),
    { Get: { state: fixture.result.markedText, mode: fixture.result.mode } },
  ];
  fs.writeFileSync(fixturePath(testCaseId), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function normalizeMode(mode: string): NeovimMode {
  switch (mode) {
    case "Normal":
    case "normal":
      return "normal";
    case "Insert":
    case "insert":
      return "insert";
    case "Visual":
    case "visual":
      return "visual";
    case "VisualLine":
    case "visualLine":
      return "visualLine";
    case "VisualBlock":
    case "visualBlock":
      return "visualBlock";
    case "Replace":
    case "replace":
      return "replace";
    default:
      throw new Error(`unexpected fixture mode: ${mode}`);
  }
}

function sanitizeTestCaseId(testCaseId: string): string {
  return testCaseId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
}
