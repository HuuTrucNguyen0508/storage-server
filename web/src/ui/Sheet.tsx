import { useEffect, useRef, type ReactNode } from "react";

/** A modal `<dialog>`: the browser traps focus, handles Escape and returns focus afterwards. */
export function Sheet({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`sheet ${className}`}
      aria-label={title}
      onClose={onClose}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="sheet-body">{children}</div>
    </dialog>
  );
}

export function ConfirmSheet({
  title,
  body,
  action,
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <h2>{title}</h2>
      <p className="sheet-text">{body}</p>
      <div className="sheet-actions">
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className={danger ? "btn solid-danger" : "btn primary"}
          type="button"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {action}
        </button>
      </div>
    </Sheet>
  );
}
