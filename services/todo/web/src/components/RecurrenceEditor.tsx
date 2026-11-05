// Edits a repeat rule as a draft; nothing is saved until Save.

import { useId, useState } from "react";
import type { Recurrence } from "../api/types";
import { localParts } from "../lib/dates";
import { describeRecurrence, type Preset, presetOf, recurrenceProblem, ruleForPreset, WEEKDAY_LONG, WEEKDAY_SHORT } from "../lib/recurrence";

export interface RecurrenceEditorProps {
  value: Recurrence | null;
  due: string | null;
  tz: string;
  onSave: (r: Recurrence | null) => void;
  onCancel: () => void;
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "none", label: "Doesn't repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "custom", label: "Every few days, weeks…" },
];

export function RecurrenceEditor({ value, due, tz, onSave, onCancel }: RecurrenceEditorProps) {
  const anchor = due ? new Date(due) : new Date();
  const p = localParts(anchor, tz);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const [draft, setDraft] = useState<Recurrence | null>(value);
  const [preset, setPreset] = useState<Preset>(presetOf(value));
  const id = useId();
  const problem = recurrenceProblem(draft);

  const choose = (pr: Preset) => {
    setPreset(pr);
    setDraft(ruleForPreset(pr, draft, weekday, p.day));
  };
  const set = (patch: Partial<Recurrence>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <form
      className="recur"
      aria-label="Repeat"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="field">
        <span className="field__label">Repeats</span>
        <span className="select">
          <select value={preset} onChange={(e) => choose(e.target.value as Preset)} data-autofocus>
            {PRESETS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </span>
      </label>

      {draft && preset === "custom" && (
        <div className="recur__row">
          <label className="recur__inline">
            <span>Every</span>
            <input
              className="input input--sm recur__num"
              type="number"
              min={1}
              max={999}
              value={Number.isFinite(draft.interval) ? draft.interval : ""}
              aria-label="Interval"
              onChange={(e) => set({ interval: e.target.value === "" ? NaN : Math.trunc(Number(e.target.value)) })}
            />
          </label>
          <span className="select select--sm">
            <select
              aria-label="Unit"
              value={draft.kind === "weekly" || draft.kind === "weekdays" ? "weeks" : draft.kind}
              onChange={(e) => {
                const kind = e.target.value as Recurrence["kind"];
                setDraft({ kind, interval: draft.interval, from: draft.from, ...(kind === "months" ? { day: p.day } : {}) });
              }}
            >
              <option value="days">days</option>
              <option value="weeks">weeks</option>
              <option value="months">months</option>
              <option value="years">years</option>
            </select>
          </span>
        </div>
      )}

      {draft?.kind === "weekly" && (
        <fieldset className="recur__days">
          <legend className="field__label">On</legend>
          {WEEKDAY_SHORT.map((d, i) => {
            const on = draft.days?.includes(i) ?? false;
            return (
              <button
                key={d}
                type="button"
                className="recur__day"
                aria-pressed={on}
                aria-label={WEEKDAY_LONG[i]}
                onClick={() => set({ days: on ? (draft.days ?? []).filter((x) => x !== i) : [...(draft.days ?? []), i].sort((a, b) => a - b) })}
              >
                {d.slice(0, 2)}
              </button>
            );
          })}
        </fieldset>
      )}

      {draft?.kind === "months" && (
        <label className="recur__inline">
          <span>On day</span>
          <input
            className="input input--sm recur__num"
            type="number"
            min={1}
            max={31}
            value={draft.day ?? ""}
            aria-label="Day of the month"
            onChange={(e) => set({ day: e.target.value === "" ? undefined : Math.trunc(Number(e.target.value)) })}
          />
          <span className="muted text-2">Short months use their last day.</span>
        </label>
      )}

      {draft && (
        <div className="seg recur__from" role="radiogroup" aria-label="Count the next one from">
          <label className="seg__opt">
            <input className="sr-only" type="radio" name={`${id}-from`} checked={draft.from === "due"} onChange={() => set({ from: "due" })} />
            <span>From the due date</span>
          </label>
          <label className="seg__opt">
            <input className="sr-only" type="radio" name={`${id}-from`} checked={draft.from === "completion"} onChange={() => set({ from: "completion" })} />
            <span>From completion</span>
          </label>
        </div>
      )}

      <p className={problem ? "field__error" : "recur__summary"} role={problem ? "alert" : undefined} data-testid="recur-summary">
        {problem ?? (draft ? describeRecurrence(draft) : "Doesn't repeat")}
        {!problem && draft && !due && <span className="muted"> Set a due date to choose where it starts.</span>}
      </p>

      <div className="row recur__actions">
        <button type="button" className="btn btn--sm btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={!!problem}>
          Save
        </button>
      </div>
    </form>
  );
}
