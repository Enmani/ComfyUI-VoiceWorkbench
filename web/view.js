import { SPEED_RANGE, PITCH_RANGE, limit, maxExtra, element, button } from "./common.js";

export const viewMethods = {
build() {
    if (!this.root) return;
    // Rebuilding replaces both players with new media elements at time zero.
    // Drop the old take's cursor too; subsequent playback/seek sets it again.
    this.pausePlayers(); this.playingSourceTime = null;
    this.waveObserver?.disconnect(); this.curveObserver?.disconnect(); this.audio = {}; this.root.replaceChildren();
    if (!this.document) {
      const empty = element("div", "ds-empty");
      empty.append(button("Load default example", () => this.open(""), "ds-primary"), element("strong", "", "Voice Workbench"), element("p", "", "Open the Voice Workbench node, then click Open editor."), element("p", "ds-muted", "Load a recording, then edit word duration and pitch before previewing the result."));
      this.status = element("p", "ds-status"); this.status.setAttribute("role", "status"); empty.append(this.status);
      this.root.append(empty); this.updateControls(); return;
    }
    const line = this.line();
    if (!line) { this.root.append(element("p", "ds-status", "This document has no editable lines.")); return; }
    this.root.classList.toggle("ds-text-pending", this.textPending());
    this.selected = this.selected && line.words.some(word => word.id === this.selected) ? this.selected :
      (line.words.find(word => word.editable) || line.words[0])?.id;
    this.sourceDuration = Number(line.source_duration || line.duration) || null;
    if (!line.timing_segments?.some(s=>s.id===this.selectedSegment)) this.selectedSegment="word:"+this.selected;
    const header = element("header", "ds-header");
    const heading = element("div", "ds-heading");
    heading.append(element("h2", "", "Voice Workbench · Time & Pitch"), element("p", "ds-muted", this.document.title || "Speech performance editor"));
    const topActions = element("div", "ds-header-actions");
    topActions.append(element("span", "ds-badge", "Continuous resynthesis"));
    this.saveBadge = element("span", "ds-badge"); topActions.append(this.saveBadge);
    this.reloadButton = button("Reload", () => this.reload());
    this.reloadButton.title = "Reload the latest document and retain compatible unsaved edits";
    this.expandButton = button("Expand editor", () => this.setExpanded(!this.expanded));
    topActions.append(this.reloadButton, this.expandButton);
    header.append(heading, topActions); this.root.append(header);
    this.status = element("p", "ds-status"); this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite"); this.root.append(this.status);
    const editorCard = element("div", "ds-editor-card");
    const cardTop = element("div", "ds-card-top");
    const selectLabel = element("label", "ds-line-select");
    const select = element("select"); select.setAttribute("aria-label", "Select line");
    for (const item of this.document.lines) {
      const option = element("option", "", `${item.speaker || "Speech"} · ${item.draft_text ?? item.text}`); option.value = item.id; select.append(option);
    }
    select.value = line.id; select.addEventListener("change", () => this.changeLine(select.value)); this.lineSelect = select;
    selectLabel.append(select); cardTop.append(selectLabel, element("span", "ds-muted", "1. Adjust   2. Preview & compare"));
    const viewport = element("div", "ds-glyph-viewport"); this.glyphViewport = viewport;
    this.wordContext = element("div", "ds-word-context");
    this.glyphs = element("div", "ds-glyphs"); this.wordContext.append(this.buildCurveSurface(), this.glyphs); viewport.append(this.wordContext);
    this.wordElements = new Map();
    this.segmentElements = new Map();
    this.wordOffsets = new Map();
    let cursor = 0;
    for (const word of line.words) {
      const index = line.text.indexOf(word.text, cursor);
      if (index >= cursor) {
        if (index > cursor) this.addPunctuation(line.text.slice(cursor, index), line.words[line.words.indexOf(word)-1]?.end_time ?? word.start_time, index);
        cursor = index + word.text.length;
      }
      this.wordOffsets.set(word.id, cursor);
      this.addGlyph(word);
    }
    if (cursor < line.text.length) this.addPunctuation(line.text.slice(cursor), line.words[line.words.length - 1]?.end_time || this.sourceDuration);
    for (const seg of line.timing_segments || []) if (seg.kind === "pause") this.addPause(seg);
    if (this.textPending()) {
      this.glyphs.replaceChildren(); this.wordElements.clear();
      let end = 0;
      for (const char of line.draft_text) {
        end += char.length; const offset = end;
        const glyph = button(char, () => {}, "ds-draft-char");
        glyph.title = "Double-click to edit"; glyph.addEventListener("dblclick", event => { event.stopPropagation(); this.beginTextEdit(offset); });
        this.glyphs.append(glyph);
      }
    }
    const detail = element("div", "ds-detail");
    const detailLeft = element("div", "ds-inline"); this.selectionLabel = element("span", "ds-detail-name");
    const numericLabel = element("label", "ds-inline"); numericLabel.append(element("span", "", "Ending extension"));
    this.extraInput = element("input", "ds-extra-input"); this.extraInput.type = "number"; this.extraInput.min = "0"; this.extraInput.step = "0.01";
    this.extraInput.setAttribute("aria-label", "Selected word ending extension in seconds");
    this.extraInput.addEventListener("change", () => {
      const before = this.snapshot(); const number = Number(this.extraInput.value);
      if (Number.isFinite(number)) this.setAmount(this.selected, number);
      this.checkpoint(before); this.refreshEditing();
    });
    numericLabel.append(this.extraInput, element("span", "ds-muted", "s")); detailLeft.append(this.selectionLabel, numericLabel);
    this.detailInfo = element("span", "ds-detail-info"); detail.append(detailLeft, this.detailInfo);
    this.conflictNote = element("p", "ds-adjustment-conflict"); this.conflictNote.setAttribute("role", "alert"); this.conflictNote.hidden = true;
    const board = element("div", "ds-unified-board");
    board.append(this.buildGlobalControls(), viewport);
    this.editTextButton = button("Edit text", () => this.beginTextEdit(this.wordOffsets.get(this.selected) ?? (line.draft_text ?? line.text).length));
    this.restoreTextButton = button("Restore recorded text", () => { const before = this.snapshot(); line.draft_text = line.text; this.checkpoint(before); this.build(); this.setStatus("Recording text restored. Existing curve and timing edits are available."); });
    this.restoreTextButton.hidden = !this.textPending();
    const textActions = element("div", "ds-text-status");
    textActions.append(this.editTextButton, this.restoreTextButton, element("span", "ds-muted", this.textPending() ? "Text draft has no matching audio yet. Regeneration archives local edits and retains global speed and pitch." : "Double-click a word to edit the text at that position."));
    editorCard.append(cardTop, this.buildPerformanceControls(), this.buildCurveToolbar(), this.buildTailControls(), this.buildTiming(), board, this.buildSegmentControls(), detail, this.conflictNote, textActions, element("p", "ds-hint", "Blue handles change word duration; green handles extend voiced endings; purple blocks are existing pauses. Double-click text to edit, or the curve to add a point."));
    this.root.append(editorCard);
    const toolbar = element("div", "ds-toolbar");
    this.undoButton = button("↶ Undo", () => this.undo()); this.undoButton.title = "Ctrl / ⌘ + Z";
    this.redoButton = button("↷ Redo", () => this.redo()); this.redoButton.title = "Ctrl / ⌘ + Shift + Z";
    this.resetButton = button("Reset line", () => { const before = this.snapshot(); Object.assign(this.line(), { tail_target: null, edits: [], timing_edits: [], speed: 1, pitch_semitones: 0, pitch_curve: [] }); this.selectedPoint = null; this.checkpoint(before); this.refreshEditing(); this.setStatus("This line's speed, pitch and local edits were reset."); });
    this.resetButton.title = "Reset this line's speed, pitch, curve and ending edits";
    this.saveButton = button("Retry save", () => this.save());
    this.saveButton.hidden = true;
    this.renderButton = button("Preview", () => this.render(), "ds-primary");
    toolbar.append(this.undoButton, this.redoButton, this.resetButton, element("span", "ds-toolbar-spacer"), this.saveButton, this.renderButton); this.root.append(toolbar);
    const comparison = element("div", "ds-comparison");
    comparison.append(this.audioCard("original", "Original"), this.audioCard("result", "Edited")); this.root.append(comparison);
    if (!this.initialFit) {
      this.pixelsPerSecond = limit((this.glyphViewport.clientWidth - 90) / this.targetDuration(), 60, 1200);
      this.initialFit = true;
    }
    this.refreshEditing(); this.loadAudio(); this.setExpanded(this.expanded);
    this.curveObserver = new ResizeObserver(() => this.drawCurve()); this.curveObserver.observe(this.wordContext);
  },
buildCurveSurface() {
    const area = element("div", "ds-curve-area"); this.curveArea = area;
    this.tailHandles=null;
    area.style.height = `${this.curveHeight}px`;
    this.curveCanvas = element("canvas", "ds-curve-canvas");
    this.curveCanvas.setAttribute("aria-label", "Pitch curve; double-click above a word to add a point");
    this.curveCanvas.addEventListener("dblclick", event => {
      if (this.busy || this.drag || this.realPitchMode) return;
      const bounds = this.curveArea.getBoundingClientRect();
      this.addCurvePoint(this.xToSource(event.clientX - bounds.left), this.yToPitch(event.clientY - bounds.top) - this.pitch());
    });
    this.curveCanvas.addEventListener("click", event => {
      const bounds = this.curveArea.getBoundingClientRect(), time = this.xToSource(event.clientX - bounds.left);
      if (this.realPitchMode) { const r = this.line().pitch_analysis?.regions?.find(r => time >= r.start_time && time <= r.end_time); if (r) this.chooseTailRegion(r); return; }
      const word = this.wordAtTime(time); if (word) this.selectWord(word.id);
    });
    this.curvePointLayer = element("div", "ds-curve-points"); this.curvePointElements = [];
    this.curvePlayhead = element("div", "ds-context-playhead"); this.curvePlayhead.hidden = true;
    this.curveTooltip = element("span", "ds-curve-tooltip"); this.curveTooltip.hidden = true;
    area.append(this.curveCanvas, this.curvePointLayer, this.curvePlayhead, this.curveTooltip);
    this.curveResizer = button("", () => {}, "ds-curve-resizer");
    this.curveResizer.setAttribute("role", "slider"); this.curveResizer.setAttribute("aria-label", "Pitch area height");
    this.curveResizer.setAttribute("aria-valuemin", "54"); this.curveResizer.setAttribute("aria-valuemax", "200");
    this.curveResizer.title = "Drag vertically to resize the pitch area";
    this.curveResizer.addEventListener("pointerdown", event => {
      if (event.button !== 0 || this.drag || this.busy) return;
      event.preventDefault(); this.drag = { kind: "curve-height", handle: this.curveResizer, pointer: event.pointerId, y: event.clientY, height: this.curveHeight };
      this.curveResizer.setPointerCapture(event.pointerId);
    });
    this.curveResizer.addEventListener("pointermove", event => this.moveDrag(event));
    this.curveResizer.addEventListener("pointerup", () => this.finishDrag(false));
    this.curveResizer.addEventListener("pointercancel", () => this.finishDrag(true));
    this.curveResizer.addEventListener("lostpointercapture", () => { if (this.drag?.handle === this.curveResizer) this.finishDrag(true); });
    this.curveResizer.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      this.setCurveHeight(event.key === "Home" ? 54 : event.key === "End" ? 200 : this.curveHeight + (event.key === "ArrowDown" ? 10 : -10));
    });
    area.append(this.curveResizer); return area;
  },
buildGlobalControls() {
    const section = element("div", "ds-global-controls"); this.parameterControls = {};
    for (const config of [
      { field: "pitch_semitones", label: "Global pitch", min: PITCH_RANGE[0], max: PITCH_RANGE[1], step: .1, unit: "semitones", left: "Low", center: "Original pitch", right: "High", reset: 0 },
    ]) {
      const control = element("div", "ds-parameter"); const heading = element("label", "ds-parameter-heading");
      const number = element("input", "ds-parameter-number"); number.type = "number";
      const range = element("input", "ds-parameter-range"); range.type = "range";
      for (const input of [range, number]) {
        input.min = String(config.min); input.max = String(config.max); input.step = String(config.step);
        input.setAttribute("aria-label", `${config.label}${input === number ? " value" : " slider"}`);
      }
      number.addEventListener("change", () => {
        const before = this.snapshot(); if (Number.isFinite(number.valueAsNumber)) this.setParameter(config.field, number.valueAsNumber);
        this.checkpoint(before); this.refreshEditing();
      });
      range.addEventListener("pointerdown", event => {
        if (this.busy || this.drag || event.button !== 0) return;
        this.pausePlayers(); this.drag = { kind: "parameter", field: config.field, handle: range, pointer: event.pointerId, before: this.snapshot() };
        range.setPointerCapture(event.pointerId);
      });
      range.addEventListener("input", () => {
        const before = this.drag ? null : this.snapshot(); this.setParameter(config.field, Number(range.value));
        if (before) this.checkpoint(before);
      });
      range.addEventListener("pointerup", () => this.finishDrag(false));
      range.addEventListener("pointercancel", () => this.finishDrag(true));
      range.addEventListener("lostpointercapture", () => { if (this.drag?.handle === range) this.finishDrag(true); });
      range.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
        if (!this.drag && !this.busy) this.drag = { kind: "parameter", field: config.field, handle: range, before: this.snapshot() };
      });
      range.addEventListener("keyup", () => { if (this.drag?.handle === range && this.drag.pointer === undefined) this.finishDrag(false); });
      range.addEventListener("blur", () => { if (this.drag?.handle === range) this.finishDrag(false); });
      heading.append(element("strong", "", config.label), number, element("span", "ds-muted", config.unit));
      const captions = element("div", "ds-range-captions"); const center = button(config.center, () => {
        const before = this.snapshot(); this.setParameter(config.field, config.reset); this.checkpoint(before);
      }, "ds-range-center");
      center.title = `Reset only ${config.label}`;
      captions.append(element("span", "", config.left), center, element("span", "", config.right));
      control.append(heading, range, captions); section.append(control);
      range.setAttribute("aria-orientation", "vertical");
      this.parameterControls[config.field] = { number, range, center, config };
    }
    const actions = element("div", "ds-global-actions");
    this.resetGlobalButton = button("Reset global controls", () => {
      const before = this.snapshot(); Object.assign(this.line(), { speed: 1, pitch_semitones: 0 });
      this.checkpoint(before); this.refreshEditing(); this.setStatus("Global speed and pitch reset. Curve and ending edits are retained.");
    });
    this.resetGlobalButton.title = "Reset global speed and pitch; keep local curve and ending edits";
    actions.append(this.resetGlobalButton, element("span", "ds-muted", "Keep curve and endings")); section.append(actions); return section;
  },
setParameter(field, value) {
    if (!Number.isFinite(value)) return;
    const bounds = field === "speed" ? SPEED_RANGE : PITCH_RANGE; const units = field === "speed" ? 1000000 : 10;
    this.line()[field] = Math.round(limit(value, ...bounds) * units) / units;
    // Global changes never silently discard or shorten a previously drawn tail.
    this.refreshEditing();
  },
addPunctuation(text, time, offset = this.line().text.length) {
    const mark = element("span", "ds-unmapped-text", text); mark.dataset.sourceTime = String(time); this.glyphs.append(mark);
    mark.addEventListener("dblclick", event => { event.stopPropagation(); this.beginTextEdit(offset); });
  },
addGlyph(word) {
    const wrapper = element("div", "ds-glyph"); wrapper.dataset.wordId = word.id; wrapper.dataset.editable = String(!!word.editable);
    const previous = this.line().words[this.line().words.findIndex(item => item.id === word.id) - 1];
    // Reserve a small visible gap for unaligned time so time-to-position remains
    // reversible even around consonant boundaries, leading and trailing silence.
    if (previous && word.start_time > previous.end_time + 1e-8) wrapper.style.marginLeft = "6px";
    const glyph = button(word.text, () => this.selectWord(word.id), "ds-char");
    glyph.addEventListener("dblclick", event => { event.stopPropagation(); this.beginTextEdit(this.wordOffsets.get(word.id) ?? this.line().text.length); });
    glyph.addEventListener("keydown", event => { if (event.key === "F2") { event.preventDefault(); event.stopPropagation(); this.beginTextEdit(this.wordOffsets.get(word.id)); } });
    glyph.setAttribute("aria-label", `Select “${word.text}”${word.editable ? ", voiced ending available" : ", no stable voiced ending"}`);
    wrapper.append(glyph, element("span", "ds-tail"));
    const segment = this.line().timing_segments?.find(s => s.id === "word:" + word.id);
    if (segment) { wrapper.classList.add("ds-has-length"); wrapper.append(this.segmentHandle(segment)); }
    let handle = null; let bubble = null;
    if (word.editable) {
      handle = button("", () => {}, "ds-handle"); handle.setAttribute("role", "slider");
      handle.setAttribute("aria-label", `Extend “${word.text}” ending`); handle.setAttribute("aria-valuemin", "0"); handle.setAttribute("aria-valuemax", String(word.max_extra));
      handle.addEventListener("pointerdown", event => this.startDrag(event, word, handle));
      handle.addEventListener("pointermove", event => this.moveDrag(event));
      handle.addEventListener("pointerup", () => this.finishDrag(false));
      handle.addEventListener("pointercancel", () => this.finishDrag(true));
      handle.addEventListener("lostpointercapture", () => { if (this.drag?.handle === handle) this.finishDrag(true); });
      handle.addEventListener("keydown", event => {
        if (this.busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); this.selected = word.id; this.selectedSegment = "word:" + word.id;
        const before = this.snapshot(); const step = event.shiftKey ? .002 : .01;
        this.setAmount(word.id, event.key === "Home" ? 0 : event.key === "End" ? this.maxExtra(word) : this.amount(word.id) + (event.key === "ArrowRight" ? step : -step));
        this.checkpoint(before); this.refreshEditing();
      });
      bubble = element("span", "ds-bubble"); bubble.setAttribute("aria-hidden", "true"); wrapper.append(handle, bubble);
    }
    this.wordElements.set(word.id, { wrapper, glyph, handle, bubble }); this.glyphs.append(wrapper);
  },
buildTiming() {
    const heading = element("div", "ds-board-time");
    this.durationInput = element("input", "ds-duration-input"); this.durationInput.type = "number"; this.durationInput.step = ".01";
    this.durationInput.setAttribute("aria-label", "Sentence target duration in seconds");
    this.durationInput.addEventListener("change", () => { if (this.busy || this.drag) return;
      const before = this.snapshot(), base = this.durationInput.valueAsNumber - this.totalExtra();
      if (Number.isFinite(base) && base > 0) this.setParameter("speed", this.sourceDuration / base);
      this.checkpoint(before); this.refreshEditing();
    });
    this.speedReadout = element("span", "ds-muted"); this.durationSummary = element("span", "ds-muted");
    this.fitButton = button("Fit timeline", () => {
      this.pixelsPerSecond = limit((this.glyphViewport.clientWidth - 90) / this.targetDuration(), 60, 1200);
      this.refreshEditing(); this.glyphViewport.scrollLeft = 0;
    }, "ds-curve-small-button");
    this.zoomOutButton = button("−", () => { this.pixelsPerSecond = Math.max(60, this.pixelsPerSecond / 1.25); this.refreshEditing(); }, "ds-curve-small-button");
    this.zoomInButton = button("＋", () => { this.pixelsPerSecond = Math.min(1200, this.pixelsPerSecond * 1.25); this.refreshEditing(); }, "ds-curve-small-button");
    this.zoomOutButton.setAttribute("aria-label", "Zoom out timeline"); this.zoomInButton.setAttribute("aria-label", "Zoom in timeline");
    heading.append(element("strong", "", "Sentence"), this.durationInput, element("span", "ds-muted", "s"), this.speedReadout,
      this.durationSummary, this.zoomOutButton, this.zoomInButton, this.fitButton);
    this.ruler = element("div", "ds-board-ruler"); this.ruler.setAttribute("aria-label", "Sentence time ruler");
    this.wordContext.append(this.ruler);
    const handle = button("", () => {}, "ds-sentence-edge"); this.timelineHandle = handle;
    handle.setAttribute("role", "slider"); handle.setAttribute("aria-label", "Drag sentence duration to adjust speaking speed");
    handle.title = "Drag the right edge to change duration; arrow keys fine-tune; Home resets speed";
    handle.addEventListener("pointerdown", event => {
      if (this.busy || this.drag || event.button !== 0) return;
      event.preventDefault(); this.pausePlayers();
      this.drag = { kind: "timeline", handle, pointer: event.pointerId, before: this.snapshot(), x: event.clientX,
        targetDuration: this.targetDuration(), pixelsPerSecond: this.pixelsPerSecond };
      handle.setPointerCapture(event.pointerId); handle.focus(); this.refreshEditing();
    });
    handle.addEventListener("pointermove", event => this.moveDrag(event));
    handle.addEventListener("pointerup", () => this.finishDrag(false));
    handle.addEventListener("pointercancel", () => this.finishDrag(true));
    handle.addEventListener("lostpointercapture", () => { if (this.drag?.handle === handle) this.finishDrag(true); });
    handle.addEventListener("keydown", event => {
      if (this.busy || this.drag || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); const before = this.snapshot();
      this.setParameter("speed", event.key === "Home" ? 1 : event.key === "End" ? SPEED_RANGE[0] : this.speed() + (event.key === "ArrowRight" ? -.01 : .01)); this.checkpoint(before);
    });
    this.timelineBubble = element("span", "ds-edge-bubble"); handle.append(this.timelineBubble); this.wordContext.append(handle);
    return heading;
  },
updateTiming() {
    if (!this.durationInput || !this.sourceDuration) return;
    const target = this.targetDuration(), width = target * this.pixelsPerSecond;
    this.wordContext.style.width = `${width + 48}px`; this.glyphs.style.width = `${width}px`;
    this.durationInput.value = target.toFixed(3);
    this.durationInput.min = String(this.sourceDuration / SPEED_RANGE[1] + this.totalExtra());
    this.durationInput.max = String(this.sourceDuration / SPEED_RANGE[0] + this.totalExtra());
    this.speedReadout.textContent = `${this.speed().toFixed(2)}×`;
    this.durationSummary.textContent = `Source ${this.sourceDuration.toFixed(3)} s · Preview ${this.line().last_result ? this.line().last_result.duration.toFixed(3) + " s" + (this.isResultStale() ? "(outdated)" : "") : "Not generated yet"}`;
    this.timelineHandle.style.left = `${width}px`; this.timelineHandle.style.height = `${this.curveHeight + 53}px`;
    this.timelineHandle.classList.toggle("ds-dragging", this.drag?.kind === "timeline");
    this.timelineHandle.setAttribute("aria-valuemin", this.durationInput.min); this.timelineHandle.setAttribute("aria-valuemax", this.durationInput.max);
    this.timelineHandle.setAttribute("aria-valuenow", String(target)); this.timelineHandle.setAttribute("aria-valuetext", `${target.toFixed(3)} s · ${this.speed().toFixed(2)} ×`);
    this.timelineBubble.textContent = `${target.toFixed(3)} s · ${this.speed().toFixed(2)}×`;
    const step = this.pixelsPerSecond >= 300 ? .2 : this.pixelsPerSecond >= 140 ? .5 : 1;
    this.ruler.replaceChildren();
    for (let t = 0; t <= target + .08; t += step) {
      const tick = element("span", "", `${t.toFixed(1)}s`); tick.style.left = `${t * this.pixelsPerSecond}px`; this.ruler.append(tick);
    }
    this.parameterControls.pitch_semitones.range.style.height = `${this.curveHeight}px`;
    for (const item of [this.durationInput, this.fitButton, this.zoomInButton, this.zoomOutButton]) item.disabled = this.busy || !!this.drag;
  }
};
