// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `test::neovim_connection::NeovimData` and
//   `test::neovim_connection::NeovimConnection::{read_test_data, write_test_data}`
// - translated concepts: JSON-lines Neovim operation fixtures
// - intentional differences: this first fixture format stores one complete comparison per
//   test case instead of replaying each low-level Neovim operation.

import fs from "fs";
import path from "path";
import { NeovimState } from "./neovim_connection.js";

export type NeovimFixtureEntry = {
  Put: { state: string };
} | {
  Key: string;
} | {
  ReadRegister: { name: string; value: string };
} | {
  Get: { state: string; mode: NeovimState["mode"] };
};

export type NeovimFixture = {
  initialState: string;
  keys: readonly string[];
  result: NeovimState;
};

const testDataDir = path.join(process.cwd(), "src", "vim", "test_data");

export function shouldRecordNeovimFixtures(): boolean {
  return process.env.VIMCODE_RECORD_NEOVIM === "1";
}

export function fixturePath(testCaseId: string): string {
  return path.join(testDataDir, `${sanitizeTestCaseId(testCaseId)}.json`);
}

export function readFixture(testCaseId: string): NeovimFixture | undefined {
  const file = fixturePath(testCaseId);
  if (!fs.existsSync(file)) return undefined;
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NeovimFixtureEntry);

  const put = entries.find((entry): entry is { Put: { state: string } } => "Put" in entry);
  const get = [...entries].reverse().find((entry): entry is { Get: { state: string; mode: NeovimState["mode"] } } => "Get" in entry);
  if (put === undefined || get === undefined) {
    throw new Error(`invalid Neovim fixture ${file}: expected Put and Get entries`);
  }

  const registers = Object.fromEntries(
    entries.flatMap((entry) => "ReadRegister" in entry ? [[entry.ReadRegister.name, entry.ReadRegister.value]] : [])
  );
  return {
    initialState: put.Put.state,
    keys: entries.flatMap((entry) => "Key" in entry ? [entry.Key] : []),
    result: { markedText: get.Get.state, mode: get.Get.mode, registers },
  };
}

export function writeFixture(testCaseId: string, fixture: NeovimFixture): void {
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

function sanitizeTestCaseId(testCaseId: string): string {
  return testCaseId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
}
