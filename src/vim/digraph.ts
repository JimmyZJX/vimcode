// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/digraph.rs and crates/vim/src/digraph/default.rs
// - translated concepts: Ctrl-k digraph lookup, including reversed pair lookup
// - intentional differences: this first slice contains only the digraphs covered by
//   enabled fixtures. Zed carries Neovim's full default digraph table plus custom
//   user-configured digraphs.

const defaultDigraphs = new Map<string, string>([
  ["o:", "ö"],
  ["a'", "á"],
  ["e`", "è"],
  ["i:", "ï"],
  ["o~", "õ"],
  ["u-", "ū"],
  ["s,", "ş"],
]);

export function lookupDigraph(first: string, second: string): string {
  return defaultDigraphs.get(`${first}${second}`)
    ?? defaultDigraphs.get(`${second}${first}`)
    ?? second;
}
