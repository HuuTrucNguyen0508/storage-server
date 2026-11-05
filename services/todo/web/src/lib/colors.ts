// Project and label colors are stored as palette names and drawn with design
// tokens, so they follow the theme and keep measured contrast. Older or
// API-default values (hex strings) map to a stable palette entry by name.

export const PALETTE = [
  { name: "ochre", label: "Ochre", css: "var(--accent-todo)" },
  { name: "cobalt", label: "Cobalt", css: "var(--accent-storage)" },
  { name: "lab", label: "Lab green", css: "var(--accent-lab)" },
  { name: "red", label: "Red", css: "var(--danger)" },
  { name: "green", label: "Leaf", css: "var(--ok)" },
  { name: "grey", label: "Grey", css: "var(--ink-3)" },
] as const;

export type ColorName = (typeof PALETTE)[number]["name"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The palette entry for a stored color; unknown values pick one from the item's name. */
export function colorOf(stored: string, name: string): (typeof PALETTE)[number] {
  return PALETTE.find((p) => p.name === stored) ?? PALETTE[hash(name.toLowerCase()) % (PALETTE.length - 1)]!;
}

export const cssColor = (stored: string, name: string) => colorOf(stored, name).css;
