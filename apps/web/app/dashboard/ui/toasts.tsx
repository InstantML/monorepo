"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export type ToastTone = "status" | "error";
export type ToastItem = { id: number; text: string; tone: ToastTone };

const MAX_VISIBLE_TOASTS = 3;
const STATUS_TOAST_MS = 5000;
const ERROR_TOAST_MS = 10000;

/* Action feedback (mutations the user clicked a button for) surfaces as
 * toasts; passive load errors stay inline where the data would render. The
 * stack lives at the app root so results stay visible over modals — the old
 * run-status line sat behind the settings modal, hiding invite failures.
 *
 * notify() returns the toast id so callers can dismiss an in-progress toast
 * ("Sending invitation...") when its result toast arrives. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const notify = useCallback((text: string, tone: ToastTone = "status") => {
    const id = nextIdRef.current++;
    setToasts((current) => [...current.slice(1 - MAX_VISIBLE_TOASTS), { id, text, tone }]);
    timersRef.current.set(id, setTimeout(() => dismissToast(id), tone === "error" ? ERROR_TOAST_MS : STATUS_TOAST_MS));
    return id;
  }, [dismissToast]);
  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  return { toasts, notify, dismissToast };
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div className={`app-toast${toast.tone === "error" ? " error" : ""}`} key={toast.id} role={toast.tone === "error" ? "alert" : "status"}>
          <span>{toast.text}</span>
          <button aria-label="Dismiss notification" className="icon-button" onClick={() => onDismiss(toast.id)} type="button"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
