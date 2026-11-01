export interface Selection {
  ids: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
  touchMode: boolean;
}

export type SelectionAction =
  | { type: "focus"; id: string }
  | { type: "toggle"; id: string }
  | { type: "extend"; id: string }
  | { type: "longPress"; id: string }
  | { type: "move"; to: "up" | "down" | "home" | "end"; extend: boolean }
  | { type: "all" }
  | { type: "clear" }
  | { type: "prune" };

export const noSelection: Selection = { ids: new Set(), anchor: null, focus: null, touchMode: false };

function targetOf(to: "up" | "down" | "home" | "end", focus: string | null, order: readonly string[]): string | null {
  if (order.length === 0) return null;
  const at = focus === null ? -1 : order.indexOf(focus);
  const last = order.length - 1;
  switch (to) {
    case "home":
      return order[0] ?? null;
    case "end":
      return order[last] ?? null;
    case "up":
      return order[Math.max(at - 1, 0)] ?? null;
    case "down":
      return order[Math.min(at + 1, last)] ?? null;
  }
}

function rangeOf(from: string, to: string, order: readonly string[]): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function selectionReducer(state: Selection, action: SelectionAction, order: readonly string[]): Selection {
  switch (action.type) {
    case "focus":
      return { ...state, focus: action.id };
    case "toggle": {
      const ids = new Set(state.ids);
      if (!ids.delete(action.id)) ids.add(action.id);
      return { ...state, ids, anchor: action.id, focus: action.id, touchMode: state.touchMode && ids.size > 0 };
    }
    case "extend": {
      const anchor = state.anchor ?? action.id;
      return { ...state, ids: new Set(rangeOf(anchor, action.id, order)), anchor, focus: action.id };
    }
    case "longPress": {
      const ids = new Set(state.ids).add(action.id);
      return { ids, anchor: action.id, focus: action.id, touchMode: true };
    }
    case "move": {
      const focus = targetOf(action.to, state.focus, order);
      if (focus === null) return state;
      if (!action.extend) return { ...state, focus, anchor: focus };
      const anchor = state.anchor ?? state.focus ?? focus;
      return { ...state, ids: new Set(rangeOf(anchor, focus, order)), anchor, focus };
    }
    case "all":
      return { ...state, ids: new Set(order) };
    case "clear":
      return { ...state, ids: new Set(), touchMode: false };
    case "prune": {
      const known = new Set(order);
      const ids = new Set([...state.ids].filter((id) => known.has(id)));
      return {
        ids,
        anchor: state.anchor !== null && known.has(state.anchor) ? state.anchor : null,
        focus: state.focus !== null && known.has(state.focus) ? state.focus : null,
        touchMode: state.touchMode && ids.size > 0,
      };
    }
  }
}

export function selectedInOrder(state: Selection, order: readonly string[]): string[] {
  return order.filter((id) => state.ids.has(id));
}
