"use client";

import { X } from "lucide-react";
import { useFocusTrap } from "../ui/use-focus-trap";

type ShortcutCommand = {
  description?: string;
  enabled: boolean;
  group: string;
  id: string;
  label: string;
  shortcut: string;
};

export function ShortcutHelpModal({
  commands,
  modifierLabel,
  onClose,
}: {
  commands: ShortcutCommand[];
  modifierLabel: string;
  onClose: () => void;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, "button[aria-label='Close keyboard shortcuts']");
  const grouped = commands.reduce<Record<string, ShortcutCommand[]>>((acc, command) => {
    acc[command.group] = [...(acc[command.group] ?? []), command];
    return acc;
  }, {});
  return (
    <div className="workspace-modal command-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" ref={dialogRef} tabIndex={-1}>
      <div className="command-card">
        <div className="drawer-head">
          <div>
            <h2>Keyboard shortcuts</h2>
            <small>{modifierLabel} maps to the platform command key.</small>
          </div>
          <button className="icon-button" type="button" aria-label="Close keyboard shortcuts" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="shortcut-groups">
          {Object.entries(grouped).map(([group, groupCommands]) => (
            <section className="shortcut-group" key={group}>
              <h3>{group}</h3>
              {groupCommands.map((command) => (
                <div className={`shortcut-row ${command.enabled ? "" : "disabled"}`} key={command.id}>
                  <span>
                    <strong>{command.label}</strong>
                    {command.description ? <small>{command.description}</small> : null}
                  </span>
                  <kbd>{command.shortcut}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
