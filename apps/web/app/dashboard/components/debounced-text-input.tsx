"use client";

import { useEffect, useRef, useState } from "react";
import type { InputHTMLAttributes, Ref } from "react";

/**
 * A text input that keeps every keystroke local and commits the value to its
 * owner debounced (and immediately on Enter or blur). Filter boxes that used
 * to write shell state on `onChange` re-rendered the entire dashboard shell
 * per keystroke (perf audit A1); routing them through this component means
 * typing re-renders only this input, and the shell sees the settled value.
 *
 * `value` stays the source of truth: external resets (clear filters, applying
 * a saved view) overwrite the local draft, while the echo of our own commit
 * never clobbers a draft the user has kept typing into.
 */
type DebouncedTextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  commitDelayMs?: number;
  inputRef?: Ref<HTMLInputElement>;
  onCommit: (value: string) => void;
  value: string;
};

export function DebouncedTextInput({
  commitDelayMs = 200,
  inputRef,
  onBlur,
  onCommit,
  onKeyDown,
  value,
  ...inputProps
}: DebouncedTextInputProps) {
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<number | null>(null);
  const lastCommittedRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);
  useEffect(() => {
    // A prop change that isn't the echo of our own commit is an external
    // reset — sync the draft to it. The echo case leaves the draft alone so
    // a user typing through the debounce window never loses characters.
    if (value !== lastCommittedRef.current) {
      lastCommittedRef.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const commit = (next: string) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (next === lastCommittedRef.current) return;
    lastCommittedRef.current = next;
    onCommitRef.current(next);
  };

  return (
    <input
      {...inputProps}
      onBlur={(event) => {
        commit(event.currentTarget.value);
        onBlur?.(event);
      }}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setDraft(next);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          commit(next);
        }, commitDelayMs);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
        onKeyDown?.(event);
      }}
      ref={inputRef}
      value={draft}
    />
  );
}
