import { BACKEND_VERSION, CURVE_MIN_GAP, CURVE_MAX_POINTS, cleanEdits, cleanCurve, cleanTiming, lineSettings, settingsSignature, maxExtra, nodeWidget, element, button, request } from "./common.js";

export const stateMethods = {
mount(host) {
    this.pausePlayers(); this.waveObserver?.disconnect(); this.curveObserver?.disconnect();
    this.portalObserver?.disconnect();
    // The frontend may dispose the tab while its editor is in the body portal.
    // Remove that old surface before mounting a replacement; keep the document.
    if (this.root && document.body && this.root.parentNode === document.body) this.root.remove();
    this.expanded = false;
    this.host = host; host.style.height = "100%"; host.style.overflow = "hidden";
    this.root = element("section", "ds-prosody");
    this.root.setAttribute("aria-label", "Voice Workbench");
    this.root.addEventListener("keydown", event => this.onKey(event));
    host.replaceChildren(this.root); this.build();
  },
setExpanded(value) {
    this.expanded = value;
    if (this.root && this.host) {
      if (value) {
        if (this.root.parentNode !== document.body) document.body.appendChild(this.root);
        this.portalObserver?.disconnect();
        this.portalObserver = new MutationObserver(() => {
          if (this.expanded && !this.host.isConnected) {
            this.setExpanded(false); this.pausePlayers();
          }
        });
        this.portalObserver.observe(document.body, { childList: true, subtree: true });
      } else {
        this.portalObserver?.disconnect();
        if (document.body && this.root.parentNode === document.body) this.host.appendChild(this.root);
      }
    }
    this.root?.classList.toggle("ds-expanded", value);
    if (this.expandButton) {
      this.expandButton.textContent = value ? "Return to node" : "Expand editor";
      this.expandButton.setAttribute("aria-expanded", String(value));
      this.expandButton.title = value ? "Return to the bottom panel (Esc)" : "Expand the editor to view text and audio comparison";
    }
    this.drawWaves(); this.drawCurve();
  },
line() { return this.document?.lines.find(line => line.id === this.document.active_line) || this.document?.lines[0]; },
textPending() { const line = this.line(); return !!line && (line.draft_text ?? line.text) !== line.text; },
beginTextEdit(offset) {
    if (this.busy || this.drag || this.textSession) return;
    this.pausePlayers();
    const text = this.line().draft_text ?? this.line().text;
    const overlay = element("div", "ds-inline-text-editor");
    const input = element("textarea", "ds-text-input"); input.value = text; input.rows = 2;
    input.setAttribute("aria-label", "Edit sentence text"); input.spellcheck = false;
    const actions = element("div", "ds-text-actions");
    const hint = element("span", "ds-muted", "Enter Finish · Esc cancels · Delete or paste text");
    actions.append(hint, button("Cancel text edit", () => this.finishTextEdit(true)), button("Finish text edit", () => this.finishTextEdit(false), "ds-primary"));
    overlay.append(input, actions); this.glyphs.append(overlay);
    this.textSession = { overlay, input, before: this.snapshot() };
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); this.finishTextEdit(true); }
      else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); this.finishTextEdit(false); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (this.finishTextEdit(false)) this.save(); }
    });
    overlay.addEventListener("keydown", event => event.stopPropagation());
    this.root.classList.add("ds-text-editing"); this.updateControls();
    input.focus(); input.setSelectionRange(offset, offset);
  },
finishTextEdit(cancelled) {
    const session = this.textSession; if (!session) return false;
    const text = session.input.value.replace(/\s*\r?\n\s*/g, " ").trim();
    if (!cancelled && (!text || [...text].length > 200 || !/[\p{L}\p{N}]/u.test(text))) {
      this.setStatus("A line needs 1–200 characters and cannot contain only whitespace or punctuation.", "error"); session.input.focus(); return false;
    }
    this.textSession = null; session.overlay.remove(); this.root.classList.remove("ds-text-editing");
    if (!cancelled) { this.line().draft_text = text; this.checkpoint(session.before); }
    this.build();
    this.setStatus(cancelled ? "Text edit cancelled." : this.textPending() ? "Text changed. Click Regenerate sentence to generate and align the full line. Local edits are archived; global speed and pitch are retained." : "Text matches the recording. Existing edits are retained.");
    return true;
  },
word() { return this.line()?.words.find(word => word.id === this.selected); },
amount(wordId) { return Number(this.line()?.edits?.find(edit => edit.word_id === wordId)?.extra_seconds || 0); },
speed() { return Number(this.line()?.speed ?? 1); },
pitch() { return Number(this.line()?.pitch_semitones ?? 0); },
curve() { return this.line()?.pitch_curve || []; },
invalidCurves() {
    return (this.document?.lines || []).flatMap((line, index) => {
      const points = cleanCurve(line.pitch_curve), duration = Number(line.source_duration || line.duration), pitch = Number(line.pitch_semitones ?? 0);
      const label = line.id === this.line()?.id ? "This line" : `#${index + 1} line`;
      if (points.length > CURVE_MAX_POINTS) return [`${label} supports at most ${CURVE_MAX_POINTS}  points`];
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!Number.isFinite(p.source_time) || !Number.isFinite(p.delta_semitones) || p.source_time < 0 || p.source_time > duration) return [`${label} has points outside the recording`];
        if (i && p.source_time - points[i - 1].source_time < CURVE_MIN_GAP - 1e-9) return [`${label} requires at least 0.02 s`];
        if (Math.abs(p.delta_semitones) > 3 || Math.abs(p.delta_semitones + pitch) > 3) return [`${label} combined curve and global pitch exceed ±3 semitones`];
      }
      return [];
    });
  },
hasInvalidSettings() { return !!(this.invalidEdits().length || this.invalidCurves().length || this.invalidTiming()); },
invalidTiming() {
    for (const line of this.document?.lines || []) for (const edit of line.timing_edits || []) {
      const seg = line.timing_segments?.find(s=>s.id===edit.segment_id);
      if (!seg) return "Some word regions changed. Reset word and pause edits.";
      const [lo,hi]=this.timingBounds(seg, Number(line.speed??1));
      if (edit.delta_seconds < lo-1e-7 || edit.delta_seconds > hi+1e-7) return "Some timing edits exceed the limits at this speed. Reduce them or reset timing edits.";
    }
    if (this.line()?.timing_edits?.length && this.durationPoints().some(p=>p[1]<.15 || p[1]>2.500001)) return "Combined word and ending edits exceed the limit. Reduce one adjustment.";
    return "";
  },
maxExtra(word) { return maxExtra(word, this.speed()); },
targetDuration() { return this.sourceDuration ? this.sourceDuration / this.speed() + this.totalExtra() : null; },
invalidEdits() {
    return (this.document?.lines || []).flatMap((line, index) => cleanEdits(line.edits)
      .filter(edit => edit.extra_seconds > maxExtra(line.words.find(word => word.id === edit.word_id), Number(line.speed ?? 1)) + 1e-6)
      .map(edit => ({ ...edit, label: `${line.id === this.line()?.id ? "" : `#${index + 1} line`}“${line.words.find(word => word.id === edit.word_id)?.text || edit.word_id}”` })));
  },
totalExtra() { return cleanEdits(this.line()?.edits).reduce((sum, edit) => sum + edit.extra_seconds, 0) + cleanTiming(this.line()?.timing_edits).reduce((sum,e)=>sum+e.delta_seconds,0); },
snapshot() { return this.document.lines.map(line => ({ id: line.id, ...lineSettings(line) })); },
draftSignature() { return JSON.stringify(this.document.lines.map(line => [line.id, lineSettings(line)])); },
isDirty() { return !!this.document && this.draftSignature() !== this.savedSignature; },
isResultStale() {
    const result = this.line()?.last_result;
    return !!result && (this.textPending() || result.backend?.version !== BACKEND_VERSION || !Array.isArray(result.edits) || settingsSignature(result) !== settingsSignature(this.line()));
  },
setStatus(message, tone = "") { this.message = message; this.messageTone = tone; this.updateControls(); },
preserveDraft() {
    if (!this.path || !this.document) return;
    try {
      if (this.isDirty()) sessionStorage.setItem(`ds-prosody:${this.path}`, JSON.stringify({ revision: this.document.revision, edits: this.snapshot() }));
      else sessionStorage.removeItem(`ds-prosody:${this.path}`);
    } catch { /* A disabled browser session store does not block explicit saving. */ }
    this.scheduleSave();
  },
scheduleSave() {
    clearTimeout(this.saveTimer);
    if (!this.isDirty()) this.autoSaveError = null;
    if (!this.isDirty() || this.autoSaveError) return;
    const path = this.path;
    this.saveTimer = setTimeout(() => {
      if (this.path !== path || !this.isDirty()) return;
      if (this.busy || this.drag || this.textSession) { this.scheduleSave(); return; }
      if (!this.hasInvalidSettings()) this.save(true);
    }, 1200);
  },
applySnapshot(snapshot) {
    this.autoSaveError = null;
    const beforeText = this.line()?.draft_text ?? this.line()?.text;
    for (const line of this.document.lines) {
      const old = snapshot.find(item => item.id === line.id);
      if (old) Object.assign(line, lineSettings(old));
    }
    if (this.selectedPoint !== null && this.selectedPoint >= this.curve().length) this.selectedPoint = null;
    if (beforeText !== (this.line()?.draft_text ?? this.line()?.text)) this.build();
    else this.refreshEditing();
    this.preserveDraft();
  },
checkpoint(before) {
    if (JSON.stringify(before) === JSON.stringify(this.snapshot())) return;
    this.autoSaveError = null;
    this.undoStack.push(before); if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = []; this.preserveDraft(); this.updateControls();
  },
undo() {
    if (this.busy || !this.undoStack.length) return;
    this.redoStack.push(this.snapshot()); this.applySnapshot(this.undoStack.pop()); this.setStatus("Last edit undone.");
  },
redo() {
    if (this.busy || !this.redoStack.length) return;
    this.undoStack.push(this.snapshot()); this.applySnapshot(this.redoStack.pop()); this.setStatus("Edit redone.");
  },
async open(path, lineId) {
    if (this.textSession) { this.setStatus("Finish or cancel the text edit first."); return; }
    if (this.busy) { this.setStatus("Processing this line. Please wait.", "error"); return; }
    if (!path) { const data = await request("/default"); path = data.document_path; }
    if (this.path === path && this.document) return await this.reload(lineId);
    this.preserveDraft(); this.busy = true; this.setStatus("Loading the recording and word alignment…");
    try {
      const data = await request(`/document?path=${encodeURIComponent(path)}`);
      this.engineEntries = (await request("/engines")).engines;
      this.pausePlayers(); this.path = data.document_path || path; this.document = data.document;
      if (lineId && this.document.lines.some(line => line.id === lineId)) this.document.active_line = lineId;
      this.savedSignature = this.draftSignature(); this.undoStack = []; this.redoStack = [];
      let restored = false;
      try {
        const saved = JSON.parse(sessionStorage.getItem(`ds-prosody:${this.path}`) || "null");
        if (saved?.revision === this.document.revision && Array.isArray(saved.edits)) {
          for (const line of this.document.lines) {
            const old = saved.edits.find(item => item.id === line.id); if (old) Object.assign(line, lineSettings(old));
          }
          restored = this.isDirty();
        }
      } catch { /* Invalid local drafts are ignored; the saved document remains authoritative. */ }
      this.selected = null; this.selectedPoint = null; this.busy = false; this.build();
      this.autoSaveError = null; this.scheduleSave();
      this.setStatus(restored ? "Unsaved edits recovered. They will be saved automatically." : "Recording loaded. Double-click the curve to add a point, drag to change pitch, and preview your changes.", restored ? "" : "ok");
      return true;
    } catch (error) { this.setStatus(error.message, "error"); return false; }
    finally { this.busy = false; this.updateControls(); }
  },
async reload(lineId) {
    if (this.textSession) { this.setStatus("Finish or cancel the text edit first."); return; }
    if (this.busy || this.drag || !this.document) return;
    const previous = this.document;
    const dirty = this.isDirty();
    // Only preserve lines whose edits differ from their saved values. Other lines
    // should receive the server's newest settings rather than a stale local copy.
    const saved = new Map(JSON.parse(this.savedSignature || "[]"));
    const localLines = dirty ? previous.lines.filter(line => JSON.stringify(lineSettings(line)) !== JSON.stringify(saved.get(line.id))) : [];
    this.preserveDraft(); this.busy = true;
    this.setStatus(dirty ? "Reloading; compatible unsaved edits will be retained…" : "Reloading the latest speech document…");
    try {
      const data = await request(`/document?path=${encodeURIComponent(this.path)}`);
      const fresh = data.document;
      // A revision update is safe to rebase only onto the same source and word
      // coordinates. Never silently attach old edits to new text or new audio.
      for (const old of localLines) {
        const next = fresh.lines.find(line => line.id === old.id);
        const oldWords = old.words.map(w => [w.id, w.text, w.start_time, w.end_time, w.sustain_start, w.sustain_end]);
        const newWords = next?.words.map(w => [w.id, w.text, w.start_time, w.end_time, w.sustain_start, w.sustain_end]);
        if (!next || next.text !== old.text || next.audio_path !== old.audio_path || JSON.stringify(oldWords) !== JSON.stringify(newWords)) {
          throw new Error("The server recording or alignment changed. Unsaved edits remain in the panel; reload compatible data before applying them");
        }
        for (const edit of cleanEdits(old.edits)) {
          const word = next.words.find(word => word.id === edit.word_id);
          if (!word?.editable) throw new Error("Editable regions changed. Your unsaved draft is retained");
        }
      }
      this.pausePlayers(); this.document = fresh;
      this.savedSignature = this.draftSignature();
      for (const old of localLines) Object.assign(this.document.lines.find(line => line.id === old.id), lineSettings(old));
      const activeId = lineId || previous.active_line;
      if (this.document.lines.some(line => line.id === activeId)) this.document.active_line = activeId;
      this.undoStack = []; this.redoStack = []; this.busy = false;
      this.build(); this.preserveDraft();
      if (!lineId) this.syncBoundNode();
      this.setStatus(dirty ? "Latest version loaded. Unsaved compatible edits are retained; preview freshness was checked." : "Latest version loaded.", "ok");
      return true;
    } catch (error) { this.setStatus(`Reload failed: ${error.message}. `, "error"); return false; }
    finally { this.busy = false; this.updateControls(); }
  },
changeLine(id) {
    if (this.busy || this.textSession || !this.document) return;
    this.pausePlayers(); this.document.active_line = id; this.selected = null; this.selectedPoint = null; this.build();
    const synced = this.syncBoundNode();
    this.setStatus(synced ? "Line selected and synchronized with the node. Each line retains its own edits." : "Line selected. Each line retains its own edits.");
  },
syncBoundNode() {
    const node = this.boundNode;
    if (!node?.graph || !this.document) return false;
    const pathKey = path => String(path || "").replaceAll("\\", "/").toLowerCase();
    if (pathKey(nodeWidget(node, "document_path")) !== pathKey(this.path)) return false;
    const widget = node.widgets?.find(item => item.name === "line_id");
    if (!widget) return false;
    const id = this.line()?.id;
    if (!id) return false;
    if (widget.value !== id) {
      widget.value = id;
      widget.callback?.(id);
      node.graph.setDirtyCanvas?.(true, true);
      node.graph.change?.();
    }
    return true;
  }
};
