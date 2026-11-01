import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastSpec {
  text: string;
  action?: ToastAction;
  ms?: number;
}

const ToastContext = createContext<(spec: ToastSpec) => void>(() => {});

export function useToast(): (spec: ToastSpec) => void {
  return useContext(ToastContext);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((spec: ToastSpec) => setToast(spec), []);

  useEffect(() => {
    if (toast === null) return;
    timer.current = window.setTimeout(() => setToast(null), toast.ms ?? 5000);
    return () => window.clearTimeout(timer.current);
  }, [toast]);

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-slot" role="status" aria-live="polite">
        {toast !== null && (
          <div className="toast">
            <span>{toast.text}</span>
            {toast.action !== undefined && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  toast.action?.run();
                  setToast(null);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
