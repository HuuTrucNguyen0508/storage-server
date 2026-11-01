import { useId, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export interface MenuItem {
  label: string;
  icon: IconName;
  danger?: boolean;
  run: () => void;
}

/** A popover sits in the top layer, so the list's rounded overflow cannot clip it. */
export function Menu({ label, items, tabIndex }: { label: string; items: MenuItem[]; tabIndex?: number }): ReactNode {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const place = () => {
    const box = button.current?.getBoundingClientRect();
    const el = panel.current;
    if (box === undefined || el === null) return;
    const below = box.bottom + 4 + el.offsetHeight < window.innerHeight;
    el.style.left = `${Math.max(8, box.right - el.offsetWidth)}px`;
    el.style.top = `${below ? box.bottom + 4 : Math.max(8, box.top - el.offsetHeight - 4)}px`;
  };
  return (
    <>
      <button ref={button} className="btn quiet icon more" type="button" aria-label={label} popoverTarget={id} tabIndex={tabIndex}>
        <Icon name="more" />
      </button>
      <div
        ref={panel}
        id={id}
        className="menu"
        popover="auto"
        onToggle={(e) => {
          if (e.newState === "open") {
            place();
            panel.current?.querySelector("button")?.focus();
          }
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className={item.danger ? "danger" : ""}
            onClick={() => {
              panel.current?.hidePopover();
              item.run();
            }}
          >
            <Icon name={item.icon} />
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
