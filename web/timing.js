import { SPEED_RANGE, seconds, cleanEdits, cleanTiming, limit, maxExtra, element, button } from "./common.js";

export const timingMethods = {
timingDelta(id) { return Number(this.line().timing_edits?.find(e=>e.segment_id===id)?.delta_seconds || 0); },
timingBounds(seg, speed = this.speed()) {
    const base=1/speed, capacity=.75*(seg.end_time-seg.start_time);
    const [lo,hi]=seg.kind==="pause"?[.25,2]:[.65,1.5];
    return [capacity*(base*lo-base), capacity*(Math.min(2.5,base*hi)-base)];
  },
currentSegment() { return this.line()?.timing_segments?.find(s=>s.id===(this.selectedSegment || "word:"+this.selected)); },
setTimingDelta(id, value) {
    const seg=this.line().timing_segments?.find(s=>s.id===id); if (!seg || !Number.isFinite(value)) return;
    const [lo,hi]=this.timingBounds(seg), delta=limit(Math.round(value*1000000)/1000000,lo,hi);
    this.line().timing_edits=cleanTiming([...(this.line().timing_edits || []).filter(e=>e.segment_id!==id),{segment_id:id,delta_seconds:delta}]);
    this.refreshEditing();
  },
chooseSegment(seg) {
    if (seg.word_id) this.selectWord(seg.word_id);
    this.selectedSegment=seg.id; this.refreshEditing();
  },
segmentHandle(seg) {
    const h=button("",()=>this.chooseSegment(seg),"ds-length-handle");
    h.setAttribute("role","slider"); h.setAttribute("aria-label", seg.kind==="pause"?`Pause duration ${seg.start_time.toFixed(3)} s`:`Adjust \'${seg.text}” word duration`);
    h.title=seg.kind==="pause"?"Drag to adjust the existing near-silent pause":"Drag left to shorten the word, or right to lengthen it";
    const bubble=element("span","ds-length-bubble"); h.append(bubble);
    this.segmentElements.set(seg.id,{handle:h,bubble});
    h.addEventListener("pointerdown",event=>{
      if(this.busy || this.drag || this.textSession || event.button!==0) return;
      event.preventDefault(); event.stopPropagation(); this.chooseSegment(seg); this.pausePlayers();
      this.drag={kind:"segment",segmentId:seg.id,handle:h,pointer:event.pointerId,x:event.clientX,amount:this.timingDelta(seg.id),pixelsPerSecond:this.pixelsPerSecond,before:this.snapshot()};
      h.setPointerCapture(event.pointerId); h.focus(); this.refreshEditing();
    });
    h.addEventListener("pointermove",e=>this.moveDrag(e)); h.addEventListener("pointerup",()=>this.finishDrag(false));
    h.addEventListener("pointercancel",()=>this.finishDrag(true));
    h.addEventListener("lostpointercapture",()=>{if(this.drag?.handle===h)this.finishDrag(true);});
    h.addEventListener("keydown",e=>{
      if(this.busy || !["ArrowLeft","ArrowRight","Home"].includes(e.key))return;
      e.preventDefault();e.stopPropagation();this.chooseSegment(seg);const before=this.snapshot();
      this.setTimingDelta(seg.id,e.key==="Home"?0:this.timingDelta(seg.id)+(e.key==="ArrowLeft"?-1:1)*(e.shiftKey?.002:.01));this.checkpoint(before);
    });
    return h;
  },
addPause(seg) {
    const block=element("div","ds-pause-block"), label=button("Pause",()=>this.chooseSegment(seg),"ds-pause-label");
    block.append(label,this.segmentHandle(seg));
    Object.assign(this.segmentElements.get(seg.id),{block,label}); this.glyphs.append(block);
  },
buildSegmentControls() {
    const row=element("div","ds-segment-controls"); this.segmentLabel=element("strong");
    this.segmentDurationInput=element("input");this.segmentDurationInput.type="number";this.segmentDurationInput.step=".01";
    this.segmentDurationInput.setAttribute("aria-label","Selected word or pause duration in seconds");
    this.segmentDurationInput.addEventListener("change",()=>{
      const seg=this.currentSegment();if(!seg)return;
      const actual=(this.sourceToX(seg.end_time)-this.sourceToX(seg.start_time))/this.pixelsPerSecond;
      const before=this.snapshot();this.setTimingDelta(seg.id,this.timingDelta(seg.id)+this.segmentDurationInput.valueAsNumber-actual);this.checkpoint(before);
    });
    this.segmentReset=button("Reset region",()=>{const seg=this.currentSegment();if(!seg)return;const before=this.snapshot();this.setTimingDelta(seg.id,0);this.checkpoint(before);});
    this.timingReset=button("Reset word & pause edits",()=>{const before=this.snapshot();this.line().timing_edits=[];this.checkpoint(before);this.refreshEditing();});
    this.segmentInfo=element("span","ds-muted");
    row.append(this.segmentLabel,this.segmentDurationInput,element("span","ds-muted","s"),this.segmentReset,this.timingReset,this.segmentInfo);return row;
  },
refreshSegments() {
    for(const seg of this.line().timing_segments || []) {
      const el=this.segmentElements?.get(seg.id);if(!el)continue;
      const a=this.sourceToX(seg.start_time),b=this.sourceToX(seg.end_time),actual=(b-a)/this.pixelsPerSecond;
      const delta=this.timingDelta(seg.id),[lo,hi]=this.timingBounds(seg);
      el.handle.setAttribute("aria-valuenow",String(actual));el.handle.setAttribute("aria-valuemin",String(actual-delta+lo));el.handle.setAttribute("aria-valuemax",String(actual-delta+hi));
      el.handle.setAttribute("aria-valuetext",`${actual.toFixed(3)} s`);
      el.handle.disabled=this.busy || (!!this.drag && this.drag.handle!==el.handle);
      el.handle.classList.toggle("ds-dragging",this.drag?.handle===el.handle);el.bubble.textContent=`${actual.toFixed(3)} s`;
      if(el.block){el.block.style.left=`${a}px`;el.block.style.width=`${Math.max(1,b-a)}px`;el.label.textContent=`Pause ${actual.toFixed(2)}s`;el.block.title=`Existing near-silence: ${actual.toFixed(3)} s; joins preserved`;}
    }
    const seg=this.currentSegment();
    if(this.segmentDurationInput){
      this.segmentDurationInput.disabled=this.busy || !!this.drag || !seg;
      this.segmentReset.disabled=this.busy || !!this.drag || !seg || !this.timingDelta(seg.id);
      this.timingReset.disabled=this.busy || !!this.drag || !this.line().timing_edits?.length;
      this.segmentLabel.textContent=seg?(seg.kind==="pause"?"Pause duration":`“${seg.text}” word duration`):"Select a word or pause";
      if(seg){const actual=(this.sourceToX(seg.end_time)-this.sourceToX(seg.start_time))/this.pixelsPerSecond,delta=this.timingDelta(seg.id),[lo,hi]=this.timingBounds(seg);
        this.segmentDurationInput.value=actual.toFixed(3);this.segmentDurationInput.min=String(actual-delta+lo);this.segmentDurationInput.max=String(actual-delta+hi);
        this.segmentInfo.textContent=seg.kind==="pause"?"Edit detected near-silence only, preserving both joins.":"Change word duration with small adjustments. Green handles independently extend voiced endings.";}
    }
  },
setAmount(wordId, value) {
    const line = this.line(); const word = line.words.find(word => word.id === wordId);
    if (!word?.editable) return;
    const amount = Math.round(Math.min(this.maxExtra(word), Math.max(0, value)) * 1000) / 1000;
    line.edits = (line.edits || []).filter(edit => edit.word_id !== wordId);
    if (amount > 0) line.edits.push({ word_id: wordId, extra_seconds: amount });
    line.edits = cleanEdits(line.edits); this.refreshEditing();
  },
startDrag(event, word, handle) {
    if (this.busy || event.button !== 0 || this.drag) return;
    event.preventDefault(); this.selectWord(word.id);
    this.pausePlayers(); this.drag = { kind: "word", wordId: word.id, handle, pointer: event.pointerId, x: event.clientX, amount: this.amount(word.id), before: this.snapshot() };
    handle.setPointerCapture(event.pointerId); handle.focus(); this.refreshEditing();
  },
moveDrag(event) {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    if (this.drag.kind === "curve-height") {
      this.setCurveHeight(this.drag.height + event.clientY - this.drag.y);
    } else if (this.drag.kind === "curve") {
      const drag = this.drag, fine = event.shiftKey ? .2 : 1;
      const time = this.xToSource(this.sourceToX(drag.point.source_time) + (event.clientX - drag.x) * fine);
      const pitch = drag.point.delta_semitones - (event.clientY - drag.y) / (this.curveHeight - 18) * 6 * fine;
      this.changeCurvePoint(drag.index, { source_time: time, delta_semitones: pitch });
    } else if (this.drag.kind === "segment") {
      const delta=(event.clientX-this.drag.x)/this.drag.pixelsPerSecond*(event.shiftKey?.2:1);
      this.setTimingDelta(this.drag.segmentId,this.drag.amount+delta);
    } else if (this.drag.kind === "word") {
      const delta = (event.clientX - this.drag.x) / this.pixelsPerSecond * (event.shiftKey ? .2 : 1);
      this.setAmount(this.drag.wordId, this.drag.amount + delta);
    } else if (this.drag.kind === "timeline") {
      const delta = (event.clientX - this.drag.x) / this.drag.pixelsPerSecond * (event.shiftKey ? .2 : 1);
      const desiredBase = this.drag.targetDuration + delta - this.totalExtra();
      this.setParameter("speed", desiredBase > 0 ? this.sourceDuration / desiredBase : SPEED_RANGE[1]);
    }
  },
finishDrag(cancelled) {
    const drag = this.drag; if (!drag) return;
    this.drag = null;
    if (drag.pointer !== undefined && drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    if (drag.kind === "curve-height") { if (cancelled) this.setCurveHeight(drag.height); this.refreshEditing(); return; }
    if (cancelled) { this.applySnapshot(drag.before); this.setStatus("Drag cancelled."); }
    else { this.checkpoint(drag.before); this.setStatus("Target updated. Click Preview to hear the result."); }
    this.refreshEditing();
  },
refreshEditing() {
    if (!this.document || !this.wordElements) return;
    for (const word of this.line().words) {
      const item = this.wordElements.get(word.id); if (!item) continue;
      const value = this.amount(word.id);
      const x = this.sourceToX(word.start_time), end = this.sourceToX(word.end_time), width = Math.max(1, end - x);
      item.wrapper.style.left = `${x}px`; item.wrapper.style.width = `${width}px`; item.wrapper.style.marginLeft = "0";
      item.wrapper.style.setProperty("--extra-width", `${value * this.pixelsPerSecond}px`);
      item.glyph.style.fontSize = "var(--ds-font-body)";
      item.glyph.title = `${word.text} · ${((end - x) / this.pixelsPerSecond).toFixed(3)} s · Double-click to edit text`;
      item.wrapper.classList.toggle("ds-selected", this.selected === word.id);
      item.wrapper.classList.toggle("ds-changed", value > 0);
      item.wrapper.classList.toggle("ds-over-limit", value > this.maxExtra(word) + 1e-6);
      item.wrapper.classList.toggle("ds-dragging", this.drag?.wordId === word.id);
      item.glyph.setAttribute("aria-pressed", String(this.selected === word.id));
      if (item.handle) {
        item.handle.setAttribute("aria-valuemax", String(this.maxExtra(word)));
        item.handle.setAttribute("aria-valuenow", String(value));
        item.handle.setAttribute("aria-valuetext", `Target extension ${seconds(value, 3)}, Preview needed`);
        item.bubble.textContent = `+${value.toFixed(3)} s · Target `;
      }
    }
    for (const mark of this.glyphs.children) if (mark.dataset.sourceTime !== undefined) mark.style.left = `${this.sourceToX(Number(mark.dataset.sourceTime))}px`;
    const word = this.word();
    if (word) {
      this.selectionLabel.textContent = `“${word.text}”`;
      this.extraInput.max = String(this.maxExtra(word)); this.extraInput.value = this.amount(word.id).toFixed(3);
      this.detailInfo.textContent = word.editable ? `Available extension at this speed: +${seconds(this.maxExtra(word), 3)} · Voiced boundaries are estimates` : "No stable voiced ending. The blue handle can still change the word duration.";
    }
    for (const [field, control] of Object.entries(this.parameterControls || {})) {
      const value = field === "speed" ? this.speed() : this.pitch();
      control.number.value = value.toFixed(field === "speed" ? 2 : 1); control.range.value = String(value);
      control.range.setAttribute("aria-valuetext", field === "speed" ? `${value.toFixed(2)} speed` : `${value > 0 ? "+" : ""}${value.toFixed(1)} semitones`);
    }
    const invalid = this.invalidEdits(), curveInvalid = this.invalidCurves();
    this.conflictNote.hidden = !invalid.length && !curveInvalid.length;
    this.conflictNote.textContent = [invalid.length ? `At this slower speed, ${invalid.map(edit => edit.label).join("、")} exceeds the ending limit. Reduce the ending extension or increase speed before saving.` : "", curveInvalid.length ? `${curveInvalid.join("；")}. Values are retained. Adjust the curve or global pitch before saving or previewing.` : ""].filter(Boolean).join(" ");
    const timingInvalid=this.invalidTiming();if(timingInvalid){this.conflictNote.hidden=false;this.conflictNote.textContent+=" "+timingInvalid;}
    this.refreshTailControls(); this.updateControls(); this.updateTiming(); this.drawWaves(); this.drawCurve();
  },
updateControls() {
    if (!this.status) return;
    this.status.textContent = this.message; this.status.dataset.tone = this.messageTone; this.status.classList.toggle("ds-busy-dot", this.busy);
    if (!this.document) return;
    this.saveBadge.textContent = this.autoSaving ? "Saving" : this.autoSaveError ? "Save failed" : this.isDirty() ? (this.hasInvalidSettings()?"Needs correction":"Unsaved") : "Saved";
    this.saveBadge.dataset.tone = this.isDirty() ? "pending" : "muted";
    this.undoButton.disabled = this.busy || !!this.drag || !this.undoStack.length;
    this.redoButton.disabled = this.busy || !!this.drag || !this.redoStack.length;
    const hasGlobals = this.speed() !== 1 || this.pitch() !== 0;
    const invalid = this.hasInvalidSettings();
    this.resetButton.disabled = this.busy || !!this.drag || (!this.line().edits?.length && !this.line().timing_edits?.length && !hasGlobals && !this.curve().length && !this.line().tail_target);
    this.resetGlobalButton.disabled = this.busy || !!this.drag || !hasGlobals;
    this.saveButton.disabled = this.busy || !!this.drag || !this.isDirty() || invalid;
    this.saveButton.hidden = !this.autoSaveError;
    this.reloadButton.disabled = this.busy || !!this.drag;
    this.renderButton.disabled = this.busy || !!this.drag || invalid;
    this.renderButton.textContent = this.busy ? "Processing…" : this.textPending() ? "Generate & compare" : "Preview";
    this.editTextButton.disabled = this.busy || !!this.drag;
    this.restoreTextButton.disabled = this.busy || !!this.drag;
    this.lineSelect.disabled = this.busy || !!this.drag;
    this.updatePerformanceControls();
    this.extraInput.disabled = this.busy || !!this.drag || !this.word()?.editable;
    for (const [field, control] of Object.entries(this.parameterControls || {})) {
      control.number.disabled = this.busy || !!this.drag;
      control.range.disabled = this.busy || (!!this.drag && !(this.drag.kind === "parameter" && this.drag.field === field));
      control.center.disabled = this.busy || !!this.drag;
    }
    for (const item of [this.durationInput, this.fitButton, this.zoomInButton, this.zoomOutButton]) if (item) item.disabled = this.busy || !!this.drag;
    if (this.timelineHandle) this.timelineHandle.disabled = this.busy || (!!this.drag && this.drag.kind !== "timeline");
    for (const item of this.wordElements.values()) { item.glyph.disabled = this.busy || !!this.drag; if (item.handle) item.handle.disabled = this.busy; }
    this.updateCurveControls();
    const result = this.line().last_result; const stale = this.isResultStale();
    const card = this.audio.result;
    if (card) {
      card.root.dataset.stale = String(stale);
      card.badge.textContent = !result ? "No preview yet" : stale ? "Outdated preview" : "Current preview";
      card.badge.dataset.tone = !result ? "muted" : stale ? "pending" : "";
    }
    if (this.textPending()) {
      if (card) card.badge.textContent = "Previous text preview";
      if (this.audio.original) this.audio.original.badge.textContent = "Previous recording; text changed";
    }
    if (this.textSession) {
      for (const control of this.root.querySelectorAll("button,input,select")) {
        if (!this.textSession.overlay.contains(control)) control.disabled = true;
      }
    }
    if(!this.textSession)this.refreshSegments();
  }
};
