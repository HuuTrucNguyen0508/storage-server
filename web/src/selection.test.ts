import { describe, expect, it } from "vitest";
import { noSelection, selectedInOrder, selectionReducer, type Selection, type SelectionAction } from "./selection";

const order = ["a", "b", "c", "d", "e"];

function run(...actions: SelectionAction[]): Selection {
  return actions.reduce((s, a) => selectionReducer(s, a, order), noSelection);
}

const picked = (s: Selection) => selectedInOrder(s, order);

describe("selection", () => {
  it("shift-click extends from a plain click, after the row takes focus", () => {
    expect(picked(run({ type: "focus", id: "b" }, { type: "click", id: "b" }, { type: "focus", id: "d" }, { type: "extend", id: "d" }))).toEqual(["b", "c", "d"]);
  });

  it("a checkbox click toggles without touching the others", () => {
    expect(picked(run({ type: "toggle", id: "b" }, { type: "toggle", id: "d" }))).toEqual(["b", "d"]);
    expect(picked(run({ type: "toggle", id: "b" }, { type: "toggle", id: "b" }))).toEqual([]);
  });

  it("shift-click selects from the anchor in either direction", () => {
    expect(picked(run({ type: "toggle", id: "b" }, { type: "extend", id: "d" }))).toEqual(["b", "c", "d"]);
    expect(picked(run({ type: "toggle", id: "d" }, { type: "extend", id: "a" }))).toEqual(["a", "b", "c", "d"]);
  });

  it("shift-click again re-extends from the same anchor instead of growing", () => {
    expect(picked(run({ type: "toggle", id: "b" }, { type: "extend", id: "e" }, { type: "extend", id: "c" }))).toEqual(["b", "c"]);
  });

  it("arrows move the focus and stop at the ends", () => {
    expect(run({ type: "move", to: "down", extend: false }).focus).toBe("a");
    expect(run({ type: "focus", id: "a" }, { type: "move", to: "up", extend: false }).focus).toBe("a");
    expect(run({ type: "focus", id: "e" }, { type: "move", to: "down", extend: false }).focus).toBe("e");
    expect(run({ type: "move", to: "end", extend: false }).focus).toBe("e");
    expect(run({ type: "focus", id: "c" }, { type: "move", to: "home", extend: false }).focus).toBe("a");
  });

  it("arrows alone change no selection", () => {
    expect(picked(run({ type: "toggle", id: "b" }, { type: "move", to: "down", extend: false }))).toEqual(["b"]);
  });

  it("shift-arrow extends from where the focus started", () => {
    const s = run(
      { type: "focus", id: "b" },
      { type: "move", to: "down", extend: true },
      { type: "move", to: "down", extend: true },
    );
    expect(picked(s)).toEqual(["b", "c", "d"]);
    expect(picked(selectionReducer(s, { type: "move", to: "up", extend: true }, order))).toEqual(["b", "c"]);
  });

  it("a long press enters touch mode and selects, and clearing the last row leaves it", () => {
    const s = run({ type: "longPress", id: "c" });
    expect(s.touchMode).toBe(true);
    expect(picked(s)).toEqual(["c"]);
    const added = selectionReducer(s, { type: "toggle", id: "a" }, order);
    expect(added.touchMode).toBe(true);
    expect(picked(added)).toEqual(["a", "c"]);
    const one = selectionReducer(added, { type: "toggle", id: "a" }, order);
    expect(selectionReducer(one, { type: "toggle", id: "c" }, order).touchMode).toBe(false);
  });

  it("mouse, keyboard and touch land on one selection", () => {
    const s = run({ type: "longPress", id: "a" }, { type: "extend", id: "c" }, { type: "move", to: "down", extend: true });
    expect(picked(s)).toEqual(["a", "b", "c", "d"]);
  });

  it("select all takes the list order, and clear empties and leaves touch mode", () => {
    expect(picked(run({ type: "all" }))).toEqual(order);
    const s = run({ type: "longPress", id: "a" }, { type: "all" }, { type: "clear" });
    expect(picked(s)).toEqual([]);
    expect(s.touchMode).toBe(false);
  });

  it("prune forgets rows that left the list", () => {
    const s = run({ type: "toggle", id: "b" }, { type: "toggle", id: "e" });
    const after = selectionReducer(s, { type: "prune" }, ["a", "b", "c"]);
    expect(selectedInOrder(after, ["a", "b", "c"])).toEqual(["b"]);
    expect(after.focus).toBe(null);
  });
});
