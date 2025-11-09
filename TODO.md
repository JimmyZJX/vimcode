# VimCode Implementation Issues TODO

This document tracks design and implementation flaws identified in the codebase during code review.

## 🔴 Critical Issues (Priority 1)

### 1. Race Condition in Delayed Actions
**Location**: `src/vim/vim.ts:374-384` (runNormal) and `src/vim/vim.ts:299-313` (runVisual)

**Problem**: When delayed actions (clipboard operations) complete asynchronously, they directly mutate `this.state` without proper synchronization. If the user continues typing while the async operation is pending, the state update could overwrite a newer state.

```typescript
r.delayed((prepare, delayed) => {
  prepare(this.editor, this.env, getInput()).then((delayedInput) => {
    if (this.lastDelayed === delayedToken) {
      // TODO this should trigger some onStateChange callbacks...
      this.state = onNormalResult(normalResult);
    }
  });
});
```

**Solution**: Need proper state management callbacks or queue-based approach for async operations.

---

### 2. Multi-line Paste Cursor Position Bug ✅ FIXED
**Location**: `src/vim/normal/change.ts:56`

**Problem**: Column calculation after pasting multi-line text is incorrect:

```typescript
const col = lineOffset === 0
  ? p.c + content.length + (mode === "before" ? 0 : 1)
  : content.length - content.lastIndexOf("\n");
```

For content `"abc\ndef"` (length 7, lastIndexOf("\n") = 3), this calculates `col = 4`, but the text after the newline is `"def"` (length 3), so cursor should be at column 3, not 4. Missing a `-1`.

**Solution**: Changed to `content.length - content.lastIndexOf("\n") - 1`

**Status**: ✅ Fixed with test coverage in `src/vim/normal/paste.multiline.test.ts`

---

### 3. Clipboard Errors Silently Ignored
**Location**: `src/vim/registers.ts:34`

**Problem**: Promise not awaited, errors silently dropped:

```typescript
editor.real_putClipboard(content);  // Promise not awaited
```

If clipboard write fails, users won't know their yank/delete didn't reach the system clipboard.

**Solution**: Either await the promise or handle errors explicitly, possibly with user notification.

---

### 4. ChordMenu Multi-Menu Resolution Logic is Broken ✅ FIXED
**Location**: `src/vim/common.ts:116-136`

**Problem**: The code itself admits it's wrong via TODO comment:

```typescript
// TODO wrong: should determine type by the first non-undefined entry
const action = entries.find((e) => e.type === "action");
if (action !== undefined) return action;
```

When multiple menus match a key, it always prefers actions over menus, which could cause incorrect command resolution and not respect menu order.

**Solution**: Simplified first-match-wins logic:
- If first entry is `action` or `delayed`: return it immediately (respects menu order)
- If first entry is `menu`: merge all menu entries together (preserves existing behavior for 'g' command with 'ge'/'gg'/etc.)

This ensures menu order is respected when there are type conflicts, while still allowing menu merging when needed.

**Status**: ✅ Fixed with test coverage in `src/vim/common.multimenu.test.ts`

---

## 🟡 Significant Design Issues (Priority 2)

### 5. Only Handles Single Selection
**Location**: `src/vim/vim.ts:58, 238, 320` and throughout codebase

**Problem**: The entire codebase assumes `selections[0]` exists and ignores any additional selections:

```typescript
const { anchor, active } = this.editor.selections[0];
```

Modern editors support multiple cursors/selections. This architecture can't be extended to support that without major refactoring.

**Solution**: Document this limitation or architect for multi-selection support from the start.

---

### 6. No Bounds Checking on Line Access
**Location**: Throughout codebase wherever `editor.getLine(pos.l)` is called

**Problem**: No verification that `pos.l < editor.getLines()`. FakeEditor returns `""` for out-of-bounds (line 46), but real editors might throw.

**Solution**: Add bounds checking wrapper or document contract that Editor implementations must handle out-of-bounds gracefully.

---

### 7. Fragile Register State Management
**Location**: `src/vim/registers.ts:16-27`

**Problem**: The `currentRegNameJustSet` flag is a one-shot boolean that relies on precise call ordering:

```typescript
public onAfterKeyProcessed(mode: Mode) {
  if (mode === "normal" && !this.currentRegNameJustSet) {
    this.currentRegName = undefined;
  }
  this.currentRegNameJustSet = false;
}
```

If `onAfterKeyProcessed` is called out of order or multiple times, register state corrupts. This is fragile temporal coupling.

**Solution**: Use a more robust state machine or clearer lifecycle management.

---

### 8. Inconsistent Cursor Position Fixing Functions
**Location**:
- `src/editorInterface.ts:29` - `fixPos`
- `src/vim/modeUtil.ts:3` - `fixNormalCursor`
- `src/vim/modeUtil.ts:9` - `fixCursor`

**Problem**: Three different functions with overlapping purposes:
- `fixPos` - allows `c = line.length`
- `fixNormalCursor` - restricts to `c = line.length - 1`
- `fixCursor` - allows `c = line.length`

Confusing API surface. Callers must know which to use when. `fixCursor` and `fixPos` appear functionally identical.

**Solution**: Consolidate to two clearly named functions (e.g., `fixInsertCursor` and `fixNormalCursor`) or add clear documentation.

---

### 9. Global Mutable State in Env
**Location**: `src/vim/vim.ts:222-230` and throughout

**Problem**: The `Env` object with `flash` state is mutated throughout the call chain with implicit clearing:

```typescript
if (env.flash === oldFlash) {
  env.flash = {};  // Implicit state clearing
}
```

Makes code hard to reason about. If an action wants to preserve flash state, it must create a new object.

**Solution**: Make flash state management more explicit or use immutable updates.

---

### 10. Visual Mode Selection Conversion Complexity
**Location**: `src/vim/modeUtil.ts:15-71`

**Problem**: The `visualFromEditor` and `visualToEditor` functions handle inclusive/exclusive selection conversion with complex logic that's error-prone and has subtle edge cases around line wrapping.

**Solution**: Add comprehensive edge case tests and consider simplifying the conversion logic.

---

## 🟢 Code Quality Issues (Priority 3)

### 11. `isFake` Flag is a Leaky Abstraction
**Location**: `src/vim/vim.ts:415`

**Problem**: Production code branches on test infrastructure:

```typescript
if (!this.editor.isFake) return false;
```

The abstraction should be complete—either fake editor should handle typing, or Vim shouldn't try to handle it.

**Solution**: Remove this flag and handle typing properly in both environments or don't handle it at all in Vim.

---

### 12. `real_*` Method Naming Convention
**Location**: `src/editorInterface.ts:61-64`

**Problem**: Methods like `real_undo()`, `real_getClipboard()` with the `real_` prefix suggest a poorly separated interface. The `Editor` interface mixes basic operations with editor-specific extensions.

**Solution**: Consider splitting into `Editor` and `EditorExtensions` interfaces or use a better naming convention.

---

### 13. Duplicated `comparePos` Function
**Location**: `src/editorInterface.ts:16` and `src/editorInterface.ts:21`

**Problem**: Defined at the top level and then redefined inside `rangeOfSelection`:

```typescript
export function comparePos(a: Pos, b: Pos): number {
  return a.l === b.l ? a.c - b.c : a.l - b.l;
}

export function rangeOfSelection(sel: Selection) {
  function comparePos(a: Pos, b: Pos): number {  // Duplicate!
    return a.l === b.l ? a.c - b.c : a.l - b.l;
  }
```

If the comparison logic needs to change, it must be updated in both places.

**Solution**: Remove the inner definition and use the exported one.

---

### 14. No Error Handling
**Location**: Throughout codebase

**Problem**: No try-catch blocks anywhere. If an action throws, it propagates uncaught and could crash the entire vim emulator state machine.

**Solution**: Add top-level error handling in `onKey` and other entry points.

---

### 15. No Input Validation
**Location**: `src/vim/vim.ts:432` - `onKey` method

**Problem**: `onKey(key: string)` doesn't validate that `key` is a valid key string. Empty strings, malformed keys like `<esc>` (should be `<escape>`), or null/undefined could cause unexpected behavior.

**Solution**: Add input validation and sanitization.

---

### 16. Mode Type Duplication
**Location**: `src/vim/vim.ts:19` (Mode type) and `src/vim/vim.ts:28-37` (State type)

**Problem**: The `Mode` type includes `"normal+"` and `"visual+"` for pending states, but the internal `State` type uses `menu: ChordMenu | undefined` to track the same concept. Two sources of truth for the same information.

The `mode` getter (vim.ts:438-447) reconstructs the mode from state, which is error-prone.

**Solution**: Unify the representation or clearly document why both are needed.

---

### 17. Empty `DelayedToken` Class
**Location**: `src/vim/vim.ts:40`

**Problem**: Using an empty class for object identity comparison:

```typescript
class DelayedToken {}
```

Not idiomatic TypeScript.

**Solution**: Use a Symbol instead: `const delayedToken = Symbol('delayed')`

---

### 18. Mixed Test and Production Code
**Location**: `src/vim/common.ts:202` - `testKeys` function

**Problem**: Test utilities in production module. Test utilities should be in test helper modules, not mixed with production code.

**Solution**: Move `testKeys` to a separate test utilities file.

---

## 🔵 Architectural Observations (Future Considerations)

### 19. No Undo/Redo Abstraction
**Location**: `src/vim/normal/change.ts:96-97`

**Problem**: The emulator calls `editor.real_undo()` directly instead of managing its own undo stack. Can't implement Vim-specific undo behavior (like undo breaks on cursor movement, or the undo tree structure).

**Solution**: Consider implementing Vim's undo tree if you want full Vim compatibility.

---

### 20. ChordMenu System Complexity
**Location**: `src/vim/common.ts:52-184`

**Problem**: The `ChordMenu<I, O>` system with its `map`, `impl`, and `multi` types is very powerful but also very complex. The `followKeyGeneric` function has deeply nested logic with continuation-passing style that's hard to understand.

**Solution**: Add comprehensive documentation and examples. Consider if simpler alternatives exist.

---

### 21. Tight Coupling to Position-Based Model
**Location**: Throughout codebase

**Problem**: All operations work with `Pos` (line/column). This makes it hard to extend to:
- Folded code regions
- Multi-byte Unicode (positions would need byte vs character disambiguation)
- Virtual text / inlay hints

The abstraction level may be too low for complex editor features.

**Solution**: Consider if a different position model would be more extensible.

---

## Summary

- **Critical bugs**: 4 issues requiring immediate attention
- **Design issues**: 7 issues that should be addressed before major expansion
- **Code quality**: 8 issues to improve maintainability
- **Architectural**: 3 observations for future consideration

**Recommended approach**: Start with Critical Issues (#1-4), then address Design Issues (#5-10) before adding major new features.
