"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export type SelectOption = {
  description?: string;
  disabled?: boolean;
  label: string;
  value: string;
};

export function CustomSelect({
  className = "",
  disabled = false,
  id,
  label,
  labelClassName = "",
  menuAlign = "left",
  menuPlacement = "bottom",
  onChange,
  options,
  value,
}: {
  className?: string;
  disabled?: boolean;
  id: string;
  label: string;
  labelClassName?: string;
  menuAlign?: "left" | "right";
  menuPlacement?: "bottom" | "top";
  onChange: (value: string) => void;
  options: SelectOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeOnOpenRef = useRef<number | null>(null);
  const focusMenuOnOpenRef = useRef(false);
  const scrollBeforeOpenRef = useRef<{ x: number; y: number } | null>(null);
  const labelId = useId();
  const valueId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0] ?? { label: "-", value: "" };
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected.value));
  const menuId = `${id}-menu`;

  useEffect(() => {
    if (!open) return undefined;
    function closeFromOutside(event: globalThis.PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const nextActiveIndex = Math.max(0, Math.min(options.length - 1, activeOnOpenRef.current ?? selectedIndex));
    const previousScroll = scrollBeforeOpenRef.current ?? { x: window.scrollX, y: window.scrollY };
    function restoreScroll() {
      window.scrollTo(previousScroll.x, previousScroll.y);
    }
    setActiveIndex(nextActiveIndex);
    if (focusMenuOnOpenRef.current) optionRefs.current[nextActiveIndex]?.focus({ preventScroll: true });
    restoreScroll();
    const restoreFrame = window.requestAnimationFrame(restoreScroll);
    const restoreTimer = window.setTimeout(() => {
      restoreScroll();
      activeOnOpenRef.current = null;
      focusMenuOnOpenRef.current = false;
      scrollBeforeOpenRef.current = null;
    }, 0);
    const restoreLateTimer = window.setTimeout(restoreScroll, 80);
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      window.clearTimeout(restoreTimer);
      window.clearTimeout(restoreLateTimer);
    };
  }, [open, options.length, selectedIndex]);

  function rememberScrollPosition(force = false) {
    if (force || !scrollBeforeOpenRef.current) scrollBeforeOpenRef.current = { x: window.scrollX, y: window.scrollY };
  }

  function openMenu(focusMenu: boolean, activeIndexOverride = selectedIndex) {
    rememberScrollPosition();
    activeOnOpenRef.current = activeIndexOverride;
    focusMenuOnOpenRef.current = focusMenu;
    setOpen(true);
  }

  function choose(option: SelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  function handleTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && event.key === "ArrowDown") {
        focusOption(activeIndex + 1);
      } else {
        openMenu(true);
      }
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (open) {
        focusOption(activeIndex - 1);
      } else {
        openMenu(true, Math.max(0, selectedIndex - 1));
      }
    }
  }

  function focusOption(index: number) {
    const bounded = Math.max(0, Math.min(options.length - 1, index));
    setActiveIndex(bounded);
    optionRefs.current[bounded]?.focus({ preventScroll: true });
  }

  function handleOptionKey(event: KeyboardEvent<HTMLButtonElement>, option: SelectOption, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(option);
    }
  }

  return (
    <div className={`control custom-select-control ${className}`} ref={rootRef}>
      <span className={labelClassName} id={labelId}>{label}</span>
      <select
        aria-hidden="true"
        className="native-select-proxy"
        disabled={disabled}
        hidden
        id={id}
        onChange={(event) => onChange(event.target.value)}
        tabIndex={-1}
        value={value}
      >
        {options.map((option) => <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <div className="custom-select">
        <button
          aria-controls={menuId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-labelledby={`${labelId} ${valueId}`}
          className="select-trigger"
          disabled={disabled}
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              rememberScrollPosition(true);
              openMenu(false);
            }
          }}
          onKeyDown={handleTriggerKey}
          onPointerDown={(event) => {
            if (disabled || open) return;
            rememberScrollPosition(true);
            event.currentTarget.focus({ preventScroll: true });
            event.preventDefault();
          }}
          type="button"
        >
          <span className="select-trigger-value" id={valueId}>
            <span>{selected.label}</span>
            {selected.description ? <span>{selected.description}</span> : null}
          </span>
          <ChevronDown size={15} />
        </button>
        {open ? (
          <div className={`select-menu ${menuAlign === "right" ? "align-right" : ""} ${menuPlacement === "top" ? "open-up" : ""}`} id={menuId} role="listbox" aria-labelledby={labelId}>
            {options.map((option, index) => {
              const optionSelected = option.value === value;
              return (
                <button
                  aria-selected={optionSelected}
                  className={`select-option ${optionSelected ? "selected" : ""} ${index === activeIndex ? "active" : ""}`}
                  disabled={option.disabled}
                  key={option.value}
                  onClick={() => choose(option)}
                  onKeyDown={(event) => handleOptionKey(event, option, index)}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  role="option"
                  type="button"
                >
                  <span className="select-check">{optionSelected ? <Check size={15} /> : null}</span>
                  <span className="select-option-text">
                    <span>{option.label}</span>
                    {option.description ? <span>{option.description}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
