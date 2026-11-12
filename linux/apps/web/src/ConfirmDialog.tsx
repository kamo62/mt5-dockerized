import { useEffect, useId, useRef, type ReactNode } from "react";

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, disabled = false }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id={`${id}-title`}>{title}</h2>
    <div id={`${id}-body`} className="dialog-description">{children}</div>
    <div className="button-row dialog-actions">
      <button ref={cancel} type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="danger-button" disabled={disabled} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </dialog>;
}
