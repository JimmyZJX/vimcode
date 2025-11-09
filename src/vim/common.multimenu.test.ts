import FakeEditor from "../fakeEditor/fakeEditor.js";
import { ChordMenu, emptyEnv, followKey } from "./common.js";

it("multi-menu with menu first, then action - should return menu", () => {
  const editor = new FakeEditor("test\n");
  const env = emptyEnv();

  let executedAction: string | undefined;

  // Create a multi-menu where:
  // - First menu: 'x' returns a MENU (multi-key command 'xy')
  // - Second menu: 'x' returns an ACTION (single-key command)
  // Expected behavior: Since first entry is a menu, return it (action is ignored)
  const multiMenu: ChordMenu<void, string> = {
    type: "multi",
    menus: [
      // First menu: 'x' is a menu (waiting for more keys)
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: {
            x: {
              type: "menu",
              menu: {
                type: "impl",
                impl: {
                  type: "keys",
                  keys: {
                    y: {
                      type: "action",
                      action: () => {
                        executedAction = "first-menu-xy";
                        return "first-menu-xy";
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      // Second menu: 'x' is an action
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: {
            x: {
              type: "action",
              action: () => {
                executedAction = "second-menu-x";
                return "second-menu-x";
              },
            },
          },
        },
      },
    ],
  };

  // Press 'x' - should return the menu from the first menu (menu before action)
  const result = followKey(multiMenu, undefined, "x", editor, env);

  // Since first entry is a menu, it should be returned (not the action from second menu)
  if (result?.type !== "menu") {
    throw new Error(
      `Expected 'x' to return a menu (from first menu), but got type: ${result?.type}`
    );
  }

  // Verify the action from second menu was NOT executed
  if (executedAction !== undefined) {
    throw new Error(
      `Second menu action should not have been executed, but got: ${executedAction}`
    );
  }

  // Now press 'y' to complete the sequence 'xy'
  const result2 = followKey(result.menu, undefined, "y", editor, env);

  if (result2?.type !== "action") {
    throw new Error(`Expected 'xy' to return an action, but got: ${result2?.type}`);
  }

  result2.action(editor, env, undefined);

  if (executedAction !== "first-menu-xy") {
    throw new Error(
      `Expected first-menu-xy to be executed, but got: ${executedAction}`
    );
  }
});

it("multi-menu with action first, then menu - should return action", () => {
  const editor = new FakeEditor("test\n");
  const env = emptyEnv();

  let executedAction: string | undefined;

  // Create a multi-menu where:
  // - First menu: 'a' returns an ACTION (single-key command)
  // - Second menu: 'a' returns a MENU (multi-key command 'ab')
  // Expected behavior: Since first entry is an action, return it (menu is ignored)
  const multiMenu: ChordMenu<void, string> = {
    type: "multi",
    menus: [
      // First menu: 'a' is an action
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: {
            a: {
              type: "action",
              action: () => {
                executedAction = "first-menu-a";
                return "first-menu-a";
              },
            },
          },
        },
      },
      // Second menu: 'a' is a menu
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: {
            a: {
              type: "menu",
              menu: {
                type: "impl",
                impl: {
                  type: "keys",
                  keys: {
                    b: {
                      type: "action",
                      action: () => {
                        executedAction = "second-menu-ab";
                        return "second-menu-ab";
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };

  // Press 'a' - should return the action from the first menu
  const result = followKey(multiMenu, undefined, "a", editor, env);

  // Since first entry is an action, it should be returned (menu from second is ignored)
  if (result?.type !== "action") {
    throw new Error(
      `Expected 'a' to return an action (from first menu), but got type: ${result?.type}`
    );
  }

  result.action(editor, env, undefined);

  if (executedAction !== "first-menu-a") {
    throw new Error(
      `Expected first-menu-a to be executed, but got: ${executedAction}`
    );
  }
});
