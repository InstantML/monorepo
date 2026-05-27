"use client";

import { Pencil, Save, X } from "lucide-react";
import { useEffect, useState } from "react";

import { runNoteText } from "../../dashboard-models";
import type { RunSummary } from "../../dashboard-types";

function tagInputValue(tags: string[]) {
  return (tags ?? []).join(", ");
}

function parseTagInput(value: string) {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 16);
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags?.length) return <span className="compare-empty">No tags</span>;
  return (
    <div className="chips">
      {tags.slice(0, 4).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
      {tags.length > 4 ? <span className="chip">+{tags.length - 4}</span> : null}
    </div>
  );
}

export function RunMetadataEditor({
  compact = false,
  onSave,
  run,
  title = "Tags and notes",
}: {
  compact?: boolean;
  onSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  run: RunSummary | null;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [tagsText, setTagsText] = useState("");
  const [notesText, setNotesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const runTagsSignature = (run?.tags ?? []).join("");
  const runNote = run ? runNoteText(run) : "";

  useEffect(() => {
    setEditing(false);
    setTagsText(tagInputValue(run?.tags ?? []));
    setNotesText(runNote);
    setError("");
  }, [run?.id, runNote, runTagsSignature]);

  if (!run) return null;
  const note = runNote;
  const currentTags = tagInputValue(run.tags);
  const dirty = tagsText.trim() !== currentTags || notesText.trim() !== note;
  const noteTooLong = new TextEncoder().encode(notesText.trim()).length > 512;
  const parsedTags = parseTagInput(tagsText);
  const disabled = !onSave || saving || !dirty || noteTooLong;

  async function save() {
    if (!onSave || disabled || !run) return;
    const runId = run.id;
    setSaving(true);
    setError("");
    try {
      await onSave(runId, { tags: parsedTags, notes: notesText.trim() });
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save tags and notes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`run-metadata-editor ${compact ? "compact" : ""}`} aria-label={title}>
      <div className="run-metadata-head">
        <span>
          <strong>{title}</strong>
          <small>{run.name}</small>
        </span>
        {editing ? (
          <span className="metadata-actions">
            <button className="secondary compact-button" type="button" onClick={() => {
              setEditing(false);
              setTagsText(currentTags);
              setNotesText(note);
              setError("");
            }} disabled={saving}><X size={14} /> Cancel</button>
            <button className="primary compact-button" type="button" onClick={save} disabled={disabled}><Save size={14} /> {saving ? "Saving" : "Save"}</button>
          </span>
        ) : onSave ? (
          <button className="secondary compact-button" type="button" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
        ) : null}
      </div>
      {editing ? (
        <div className="metadata-edit-grid">
          <label className="control">
            Tags
            <textarea className="tag-textarea" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="baseline, needs-review" rows={compact ? 2 : 3} />
          </label>
          <div className="metadata-tag-preview" aria-label="Parsed tags">
            {parsedTags.length ? parsedTags.map((tag) => <span className="chip" key={tag} title={tag}>{tag}</span>) : <span className="compare-empty">No tags</span>}
          </div>
          <label className="control notes-control">
            Notes
            <textarea value={notesText} onChange={(event) => setNotesText(event.target.value)} placeholder="Why this run matters" rows={compact ? 2 : 4} />
          </label>
          {noteTooLong ? <small className="form-error">Notes must be at most 512 bytes.</small> : null}
          {error ? <small className="form-error">{error}</small> : null}
        </div>
      ) : (
        <div className="metadata-read">
          <TagList tags={run.tags} />
          <p title={note}>{note || "No notes yet."}</p>
        </div>
      )}
    </section>
  );
}
