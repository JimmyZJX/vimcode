import FakeEditor from "./fakeEditor.js";

it("getLine warns on out-of-bounds access", () => {
  const editor = new FakeEditor("line1\nline2\nline3");
  const warnSpy = jest.spyOn(console, "warn").mockImplementation();

  // Valid access - no warning
  const line0 = editor.getLine(0);
  expect(line0).toBe("line1");
  expect(warnSpy).not.toHaveBeenCalled();

  const line2 = editor.getLine(2);
  expect(line2).toBe("line3");
  expect(warnSpy).not.toHaveBeenCalled();

  // Out of bounds - should warn and return ""
  const lineNeg = editor.getLine(-1);
  expect(lineNeg).toBe("");
  expect(warnSpy).toHaveBeenCalledWith(
    "[FakeEditor] Out of bounds getLine(-1). Valid range: [0, 2]. Returning \"\"."
  );

  warnSpy.mockClear();

  const line99 = editor.getLine(99);
  expect(line99).toBe("");
  expect(warnSpy).toHaveBeenCalledWith(
    "[FakeEditor] Out of bounds getLine(99). Valid range: [0, 2]. Returning \"\"."
  );

  warnSpy.mockRestore();
});

it("getLineLength warns on out-of-bounds access", () => {
  const editor = new FakeEditor("abc\ndefgh");
  const warnSpy = jest.spyOn(console, "warn").mockImplementation();

  // Valid access - no warning
  const len0 = editor.getLineLength(0);
  expect(len0).toBe(3); // "abc"
  expect(warnSpy).not.toHaveBeenCalled();

  const len1 = editor.getLineLength(1);
  expect(len1).toBe(5); // "defgh"
  expect(warnSpy).not.toHaveBeenCalled();

  // Out of bounds - should warn and return 0
  const lenNeg = editor.getLineLength(-5);
  expect(lenNeg).toBe(0);
  expect(warnSpy).toHaveBeenCalledWith(
    "[FakeEditor] Out of bounds getLineLength(-5). Valid range: [0, 1]. Returning 0."
  );

  warnSpy.mockClear();

  const len10 = editor.getLineLength(10);
  expect(len10).toBe(0);
  expect(warnSpy).toHaveBeenCalledWith(
    "[FakeEditor] Out of bounds getLineLength(10). Valid range: [0, 1]. Returning 0."
  );

  warnSpy.mockRestore();
});

it("contract: empty document has 1 line", () => {
  const editor = new FakeEditor("");
  expect(editor.getLines()).toBe(1);
  expect(editor.getLine(0)).toBe("");
  expect(editor.getLineLength(0)).toBe(0);
});
