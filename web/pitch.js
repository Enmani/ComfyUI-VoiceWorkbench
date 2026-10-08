import { PITCH_RANGE, CURVE_MIN_GAP, CURVE_MAX_POINTS, copy, cleanCurve, limit, curveValue, mappedSourceTime, mapAnchors, element, button } from "./common.js";

export const pitchMethods = {
buildTailControls() {
    this.realPitchMode ??= false;
    const row = element("div", "ds-tail-controls"); this.tailControls = row;
    this.tailModeButton = button("", () => { this.realPitchMode = !this.realPitchMode; this.refreshEditing(); });
    this.tailPresetButton = button("Rising ending", () => {
      const regions = this.line().pitch_analysis?.regions || [];
      if (regions.length) this.chooseTailRegion(regions[regions.length-1]);
    });
    this.tailClearButton = button("Clear ending target", () => { const before=this.snapshot(); this.line().tail_target=null; this.checkpoint(before); this.refreshEditing(); });
    row.append(this.tailModeButton, this.tailPresetButton);
    this.tailInputs={};
    for (const [key,label,step] of [["start_time","Start (s)",.005],["end_time","End (s)",.005],["start_hz","Start (Hz)",1],["end_hz","End (Hz)",1]]) {
      const wrap=element("label","ds-tail-value",label), input=element("input"); input.type="number"; input.step=String(step); input.setAttribute("aria-label",`Voiced-tail target ${label}`);
      input.addEventListener("change",()=>{const n=input.valueAsNumber; if (!Number.isFinite(n)||!this.line().tail_target) return this.refreshEditing(); const before=this.snapshot(),target={...this.line().tail_target,[key]:n}; const error=this.tailError(target); if(error){this.setStatus(error,"error");this.refreshEditing();return;} this.line().tail_target=target;this.checkpoint(before);this.refreshEditing();});
      wrap.append(input); row.append(wrap); this.tailInputs[key]=input;
    }
    row.append(this.tailClearButton);
    this.tailHint=element("span","ds-muted");row.append(this.tailHint);return row;
  },
tailError(target) {
    if(!target)return "";
    const {start_time:a,end_time:b,start_hz:h,end_hz:k}=target,analysis=this.line().pitch_analysis;
    if(!Object.values(target).every(Number.isFinite)||b-a<.06-1e-8||b-a>.5+1e-8||h<75||h>600||k<75||k>600||!analysis?.regions?.some(r=>a>=r.start_time-1e-6&&b<=r.end_time+1e-6))return "Choose 0.06–0.5 seconds within one green voiced region; target pitch must be 75–600 Hz.";
    if(analysis.frames.some(f=>f.reliable&&f.time>=a&&f.time<=b&&Math.abs(12*Math.log2((h*(k/h)**((f.time-a)/(b-a)))/f.hz))>6+1e-6))return "Target differs from the source by more than 6 semitones. Reduce the change.";
    return "";
  },
chooseTailRegion(region) {
    if(this.busy||this.drag||this.textPending())return;
    const a=Math.max(region.start_time,region.end_time-.25),b=region.end_time,frames=this.line().pitch_analysis.frames.filter(f=>f.reliable&&f.time>=a&&f.time<=b);
    if(!frames.length)return;
    const first=frames[0],last=frames[frames.length-1],baseline=f=>f.hz*2**((this.pitch()+curveValue(this.curve(),f.time))/12);
    let target={start_time:a,end_time:b,start_hz:Math.round(baseline(first)),end_hz:Math.round(Math.max(baseline(first),baseline(last))*2**(2/12))};
    if(this.tailError(target))target.end_hz=Math.round(baseline(last));
    const error=this.tailError(target);if(error)return this.setStatus(error,"error");
    const before=this.snapshot();this.line().tail_target=target;this.realPitchMode=true;this.checkpoint(before);this.refreshEditing();this.setStatus("Stable ending selected. Drag the gold points to set target pitch; joins blend over 20 ms. Unvoiced audio is excluded.");
  },
refreshTailControls() {
    if(!this.tailInputs)return;
    const target=this.line().tail_target,blocked=this.busy||!!this.drag||this.textPending();
    this.tailModeButton.textContent=this.realPitchMode?"Show relative shift":"Show measured pitch";
    this.tailModeButton.disabled=blocked;this.tailPresetButton.disabled=blocked||!this.line().pitch_analysis?.regions?.length;
    this.tailClearButton.disabled=blocked||!target;
    for(const [key,input] of Object.entries(this.tailInputs)){input.disabled=blocked||!target;input.value=target?target[key].toFixed(key.endsWith("hz")?0:3):"";}
    this.tailControls.hidden=this.textPending();
    this.tailHint.textContent=target?`${(target.end_time-target.start_time).toFixed(3)} s · Absolute pitch overrides the relative curve in this region, with blended joins` : "Select a green voiced region or click Rising ending. Shaded regions are unvoiced or unstable.";
  },
drawRealPitch(ctx,width,height) {
    const analysis=this.line().pitch_analysis,target=this.line().tail_target;
    if(!analysis)return;
    const y=hz=>height-10-(Math.log2(hz/75)/3)*(height-20), frames=analysis.frames;
    ctx.fillStyle="#0c141888";ctx.fillRect(0,0,width,height);
    for(const r of analysis.regions){ctx.fillStyle="#7de3cd16";ctx.fillRect(this.sourceToX(r.start_time),0,this.sourceToX(r.end_time)-this.sourceToX(r.start_time),height);}
    for(const hz of [75,150,300,600]){ctx.strokeStyle="#34464b";ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(0,y(hz));ctx.lineTo(width,y(hz));ctx.stroke();ctx.fillStyle="#9aafb4";ctx.font="10px sans-serif";ctx.fillText(`${hz} Hz`,5,y(hz)-2);}ctx.setLineDash([]);
    const plot=(data,color,mapX,value)=>{ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();let connected=false;for(const f of data){if(!f.reliable||!f.hz){connected=false;continue;}const px=mapX(f.time),py=y(value(f));if(connected)ctx.lineTo(px,py);else ctx.moveTo(px,py);connected=true;}ctx.stroke();};
    plot(frames,"#96a4aa",t=>this.sourceToX(t),f=>f.hz);
    plot(frames,"#efbc73",t=>this.sourceToX(t),f=>{let hz=f.hz*2**((this.pitch()+curveValue(this.curve(),f.time))/12);if(target){const {start_time:a,end_time:b,start_hz:h,end_hz:k}=target,ramp=Math.min(.02,(b-a)/4),u=limit((f.time-a)/(b-a),0,1);let w=limit(Math.min((f.time-a)/ramp,(b-f.time)/ramp),0,1);w=w*w*(3-2*w);hz=Math.exp(Math.log(hz)*(1-w)+Math.log(h*(k/h)**u)*w);}return hz;});
    const result=this.line().last_result;
    if(result?.pitch_analysis&&!this.isResultStale()){
      const pts=result.curve.map(p=>[p.time,p.multiplier]);
      plot(result.pitch_analysis.frames,"#7de3cd",t=>{let a=0,b=this.sourceDuration;for(let i=0;i<28;i++){const m=(a+b)/2;if(mappedSourceTime(m,pts)<t)a=m;else b=m;}return this.sourceToX((a+b)/2);},f=>f.hz);
    }
    if(!this.tailHandles){this.tailHandles=[];for(const key of ["start_hz","end_hz"]){const handle=button("",()=>{},"ds-tail-point");handle.setAttribute("role","slider");handle.setAttribute("aria-label",key==="start_hz"?"Ending start pitch":"Ending end pitch");
      handle.addEventListener("pointerdown",e=>{if(this.busy||this.drag||e.button!==0)return;e.preventDefault();this.pausePlayers();this.drag={kind:"tail-target",key,handle,before:this.snapshot(),pointer:e.pointerId};handle.setPointerCapture(e.pointerId);});
      handle.addEventListener("pointermove",e=>{if(this.drag?.kind!=="tail-target"||this.drag.key!==key)return;const rect=this.curveArea.getBoundingClientRect(),hz=Math.round(75*2**(limit((this.curveHeight-10-(e.clientY-rect.top))/(this.curveHeight-20),0,1)*3)),next={...this.line().tail_target,[key]:hz};if(!this.tailError(next)){this.line().tail_target=next;this.refreshEditing();}});
      const end=cancel=>{if(this.drag?.kind==="tail-target")this.finishDrag(cancel);};
      handle.addEventListener("pointerup",()=>end(false));handle.addEventListener("pointercancel",()=>end(true));handle.addEventListener("lostpointercapture",()=>end(true));
      handle.addEventListener("keydown",e=>{if(e.key==="Escape"&&this.drag?.kind==="tail-target"){end(true);return;}if(this.busy||!["ArrowUp","ArrowDown"].includes(e.key))return;e.preventDefault();const before=this.snapshot(),next={...this.line().tail_target,[key]:this.line().tail_target[key]+(e.key==="ArrowUp"?1:-1)*(e.shiftKey?1:5)};if(!this.tailError(next)){this.line().tail_target=next;this.checkpoint(before);this.refreshEditing();}});
      this.curveArea.append(handle);this.tailHandles.push(handle);}}
    this.tailHandles.forEach((h,i)=>{h.hidden=!target||!this.realPitchMode;h.disabled=this.busy||(!!this.drag&&this.drag.kind!=="tail-target");if(target){const hz=target[i?"end_hz":"start_hz"];h.style.left=`${this.sourceToX(target[i?"end_time":"start_time"])}px`;h.style.top=`${y(hz)}px`;h.setAttribute("aria-valuenow",String(hz));h.title=`Target ${hz} Hz · Drag or use up/down arrows`;}});
    if(target){ctx.strokeStyle="#efbc7399";ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(this.sourceToX(target.start_time),y(target.start_hz));ctx.lineTo(this.sourceToX(target.end_time),y(target.end_hz));ctx.stroke();ctx.setLineDash([]);}
  },
buildCurveToolbar() {
    const toolbar = element("div", "ds-curve-toolbar");
    const title = element("div", "ds-curve-heading");
    this.curveModeNote = element("span", "ds-muted", "Total shift · 0 preserves source pitch");
    title.append(element("strong", "", "Pitch curve"), this.curveModeNote);
    this.curveExpandButton = button("Expand curve", () => this.setCurveHeight(this.curveHeight < 100 ? 135 : 54), "ds-curve-small-button");
    this.curveAddButton = button("Add point at selected word", () => {
      const word = this.word(); if (word) this.addCurvePoint((word.start_time + word.end_time) / 2);
    }, "ds-curve-small-button");
    this.curveDeleteButton = button("Delete point", () => this.deleteCurvePoint(), "ds-curve-small-button");
    this.curveClearButton = button("Clear curve", () => {
      const before = this.snapshot(); this.line().pitch_curve = []; this.selectedPoint = null;
      this.checkpoint(before); this.refreshEditing(); this.setStatus("Curve cleared. Global speed, pitch and ending edits are retained.");
    }, "ds-curve-small-button");
    const values = element("div", "ds-curve-values");
    this.curveTimeInput = element("input", "ds-curve-number"); this.curveTimeInput.type = "number"; this.curveTimeInput.min = "0"; this.curveTimeInput.step = ".01";
    this.curveTimeInput.setAttribute("aria-label", "Point source time in seconds"); this.curveTimeInput.title = "Source-time anchor follows the same word after timing edits";
    this.curvePitchInput = element("input", "ds-curve-number"); this.curvePitchInput.type = "number"; this.curvePitchInput.min = "-3"; this.curvePitchInput.max = "3"; this.curvePitchInput.step = ".1";
    this.curvePitchInput.setAttribute("aria-label", "Point total pitch shift in semitones");
    for (const [input, field] of [[this.curveTimeInput, "source_time"], [this.curvePitchInput, "delta_semitones"]]) {
      input.addEventListener("change", () => {
        if (this.selectedPoint === null || !Number.isFinite(input.valueAsNumber)) { this.refreshEditing(); return; }
        const before = this.snapshot(); this.changeCurvePoint(this.selectedPoint, { [field]: input.valueAsNumber - (field === "delta_semitones" ? this.pitch() : 0) }); this.checkpoint(before);
      });
    }
    values.append(this.curveTimeInput, element("span", "ds-muted", "s"), this.curvePitchInput, element("span", "ds-muted", "semitones"));
    toolbar.append(title, this.curveExpandButton, this.curveAddButton, this.curveDeleteButton, values, this.curveClearButton); return toolbar;
  },
setCurveHeight(height) {
    this.curveHeight = Math.round(limit(height, 54, 200));
    if (this.curveArea) this.curveArea.style.height = `${this.curveHeight}px`;
    if (this.curveExpandButton) { this.curveExpandButton.textContent = this.curveHeight < 100 ? "Expand curve" : "Collapse curve"; this.curveExpandButton.setAttribute("aria-expanded", String(this.curveHeight >= 100)); }
    this.curveResizer?.setAttribute("aria-valuenow", String(this.curveHeight)); this.updateTiming(); this.drawCurve();
  },
wordAtTime(time) {
    const words = this.line()?.words || [];
    return words.find(word => time >= word.start_time && time <= word.end_time) || words.reduce((best, word) => !best || Math.abs(time - (word.start_time + word.end_time) / 2) < Math.abs(time - (best.start_time + best.end_time) / 2) ? word : best, null);
  },
selectWord(id) {
    this.selected = id;
    this.selectedSegment = "word:" + id;
    const word = this.word(), points = this.curve();
    const candidates = points.map((point, index) => ({ point, index })).filter(({ point }) => this.wordAtTime(point.source_time)?.id === id);
    this.selectedPoint = candidates.length ? candidates.reduce((best, next) => Math.abs(next.point.source_time - (word.start_time + word.end_time) / 2) < Math.abs(best.point.source_time - (word.start_time + word.end_time) / 2) ? next : best).index : null;
    this.refreshEditing();
  },
selectCurvePoint(index) {
    const point = this.curve()[index]; if (!point) return;
    this.selectedPoint = index; this.selected = this.wordAtTime(point.source_time)?.id || this.selected;
    this.selectedSegment = "word:" + this.selected; this.refreshEditing();
  },
addCurvePoint(time, pitch = undefined) {
    if (this.busy || this.drag) return;
    const points = cleanCurve(this.curve()); let value = limit(Math.round(time * 1000000) / 1000000, 0, this.sourceDuration);
    if (points.length >= CURVE_MAX_POINTS) { this.setStatus(`Add at most ${CURVE_MAX_POINTS}  pitch points.`, "error"); return; }
    const nearby = points.findIndex(point => Math.abs(point.source_time - value) < CURVE_MIN_GAP - 1e-9);
    if (nearby >= 0) { this.selectCurvePoint(nearby); this.setStatus("Existing point selected. Points need at least 0.02 s. "); return; }
    const before = this.snapshot();
    const first = !points.length, delta = Math.round(limit(pitch ?? curveValue(points, value), ...PITCH_RANGE) * 1000) / 1000;
    // Materialize neutral boundaries only on the first edit, not when loading an
    // empty document. One middle point should bend that word, not shift all speech.
    if (first && this.sourceDuration >= CURVE_MIN_GAP) {
      points.push({ source_time: 0, delta_semitones: 0 }, { source_time: this.sourceDuration, delta_semitones: 0 });
      if (value < CURVE_MIN_GAP) value = 0;
      else if (this.sourceDuration - value < CURVE_MIN_GAP) value = this.sourceDuration;
    }
    const boundary = points.find(point => point.source_time === value);
    if (boundary) boundary.delta_semitones = delta;
    else points.push({ source_time: value, delta_semitones: delta });
    this.line().pitch_curve = cleanCurve(points); this.selectedPoint = this.curve().findIndex(point => point.source_time === value);
    this.selected = this.wordAtTime(value)?.id || this.selected; this.selectedSegment = "word:" + this.selected;
    this.checkpoint(before); this.refreshEditing();
    this.setStatus(first ? "Point added with zero-shift endpoints. Drag vertically to adjust pitch, then Preview." : "Point added. Drag for pitch and time, then Preview.");
  },
changeCurvePoint(index, changes) {
    const points = cleanCurve(this.curve()), point = points[index]; if (!point) return;
    if (Number.isFinite(changes.source_time)) point.source_time = limit(Math.round(changes.source_time * 1000000) / 1000000, index ? points[index - 1].source_time + CURVE_MIN_GAP : 0, index < points.length - 1 ? points[index + 1].source_time - CURVE_MIN_GAP : this.sourceDuration);
    if (Number.isFinite(changes.delta_semitones)) point.delta_semitones = Math.round(limit(changes.delta_semitones, ...PITCH_RANGE) * 1000) / 1000;
    this.line().pitch_curve = points; this.selectedPoint = index;
    this.selected = this.wordAtTime(point.source_time)?.id || this.selected;
    this.selectedSegment = "word:" + this.selected;
    this.refreshEditing();
  },
deleteCurvePoint() {
    if (this.busy || this.drag || this.selectedPoint === null) return;
    const before = this.snapshot(); this.line().pitch_curve = this.curve().filter((_, i) => i !== this.selectedPoint); this.selectedPoint = null;
    this.checkpoint(before); this.refreshEditing(); this.setStatus("Point removed. The remaining curve stays smooth.");
  },
durationPoints() {
    const base = 1 / this.speed(), points = new Map([[0, base], [this.sourceDuration, base]]);
    for (const word of this.line().words) {
      const extra = this.amount(word.id), a = Number(word.sustain_start), b = Number(word.sustain_end);
      if (!extra || !Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      const transition = (b - a) * .25, peak = base + extra / ((b - a) - transition);
      for (const point of [[a, base], [a + transition, peak], [b - transition, peak], [b, base]]) points.set(...point);
    }
    const original = [...points].sort((a,b)=>a[0]-b[0]), bumps=[];
    for (const edit of this.line().timing_edits || []) {
      const seg=this.line().timing_segments?.find(s=>s.id===edit.segment_id); if (!seg) continue;
      const a=seg.start_time,b=seg.end_time,peak=edit.delta_seconds/(.75*(b-a));
      bumps.push([[a,0],[a+(b-a)*.25,peak],[b-(b-a)*.25,peak],[b,0]]);
    }
    const knots=[...new Set([...original.map(p=>p[0]), ...bumps.flatMap(b=>b.map(p=>p[0]))])].sort((a,b)=>a-b);
    const at=(p,t)=>{ if(t<p[0][0] || t>p[p.length-1][0]) return 0; for(let i=1;i<p.length;i++) if(t<=p[i][0]) return p[i-1][1]+(p[i][1]-p[i-1][1])*(t-p[i-1][0])/(p[i][0]-p[i-1][0]); return p[p.length-1][1]; };
    return knots.map(t=>[t,at(original,t)+bumps.reduce((sum,p)=>sum+at(p,t),0)]);
  },
sourceAnchors() {
    const points = this.durationPoints(), times = new Set(points.map(p => p[0]));
    for (let t = 0; t < this.sourceDuration; t += .005) times.add(t);
    return [...times].sort((a, b) => a - b).map(t => [t, mappedSourceTime(t, points) * this.pixelsPerSecond]);
  },
sourceToX(time) { return mappedSourceTime(limit(time, 0, this.sourceDuration), this.durationPoints()) * this.pixelsPerSecond; },
xToSource(x) {
    let a = 0, b = this.sourceDuration;
    for (let i = 0; i < 35; i++) { const mid = (a + b) / 2; if (this.sourceToX(mid) < x) a = mid; else b = mid; }
    return (a + b) / 2;
  },
mapCoordinate(value, inverse = false) { return inverse ? this.xToSource(value) : this.sourceToX(value); },
pitchToY(pitch) { return 9 + (3 - pitch) / 6 * (this.curveHeight - 18); },
yToPitch(y) { return limit(3 - (y - 9) / (this.curveHeight - 18) * 6, ...PITCH_RANGE); },
drawCurve() {
    if (!this.curveCanvas || !this.document || !this.wordElements || !this.curveArea) return;
    const width = this.curveArea.clientWidth, height = this.curveHeight;
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1;
    this.curveCanvas.width = Math.round(width * scale); this.curveCanvas.height = Math.round(height * scale);
    const ctx = this.curveCanvas.getContext("2d"); if (!ctx) return;
    ctx.scale(scale, scale); ctx.clearRect(0, 0, width, height);
    this.curveArea.dataset.realPitch=String(!!this.realPitchMode);
    this.curveCanvas.setAttribute("aria-label",this.realPitchMode?"Measured pitch: gray source, gold target, green output. Select a stable voiced region for an ending target":"Relative pitch curve; double-click to add a point");
    this.curvePointLayer.hidden = !!this.realPitchMode;
    if(this.tailHandles)for(const h of this.tailHandles)h.hidden=!this.realPitchMode||!this.line().tail_target;
    if (this.realPitchMode) { this.drawRealPitch(ctx, width, height); this.updateContextPlayhead(); return; }
    const selectedBounds = this.wordElements.get(this.selected)?.wrapper.getBoundingClientRect(), contextLeft = this.wordContext.getBoundingClientRect().left;
    if (selectedBounds) { ctx.fillStyle = "#7de3cd12"; ctx.fillRect(selectedBounds.left - contextLeft, 0, selectedBounds.width, height); }
    for (const pitch of [-3, -2, -1, 0, 1, 2, 3]) {
      const y = this.pitchToY(pitch); ctx.strokeStyle = pitch ? "#314149" : "#587478"; ctx.lineWidth = 1;
      ctx.setLineDash(pitch ? [2, 5] : [5, 4]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    const points = cleanCurve(this.curve()), anchors = this.sourceAnchors(), end = mapAnchors(anchors, this.sourceDuration);
    ctx.strokeStyle = this.invalidCurves().length ? "#f2a48b" : "#e9bf80"; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x <= end; x += 2) { const y = this.pitchToY(this.pitch() + curveValue(points, mapAnchors(anchors, x, true))); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.lineTo(end, this.pitchToY(this.pitch() + curveValue(points, this.sourceDuration))); ctx.stroke();
    // Reuse point elements while dragging so pointer capture and keyboard focus survive.
    while (this.curvePointElements.length > points.length) this.curvePointElements.pop().remove();
    while (this.curvePointElements.length < points.length) {
      const index = this.curvePointElements.length, handle = button("", () => this.selectCurvePoint(index), "ds-curve-point");
      handle.setAttribute("role", "slider"); handle.setAttribute("aria-valuemin", "-3"); handle.setAttribute("aria-valuemax", "3");
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0 || this.busy || this.drag) return;
        event.preventDefault(); event.stopPropagation(); this.pausePlayers(); this.selectCurvePoint(index);
        this.drag = { kind: "curve", index, handle, pointer: event.pointerId, x: event.clientX, y: event.clientY, point: copy(this.curve()[index]), before: this.snapshot() };
        handle.setPointerCapture(event.pointerId); handle.focus(); this.refreshEditing();
      });
      handle.addEventListener("pointermove", event => this.moveDrag(event));
      handle.addEventListener("pointerup", () => this.finishDrag(false));
      handle.addEventListener("pointercancel", () => this.finishDrag(true));
      handle.addEventListener("lostpointercapture", () => { if (this.drag?.handle === handle) this.finishDrag(true); });
      handle.addEventListener("keydown", event => {
        if (this.busy || this.drag || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "Delete", "Backspace"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); this.selectCurvePoint(index);
        if (["Delete", "Backspace"].includes(event.key)) return this.deleteCurvePoint();
        const before = this.snapshot(), point = this.curve()[index], fine = event.shiftKey;
        const change = event.key === "Home" ? { delta_semitones: 0 } : event.key === "ArrowLeft" || event.key === "ArrowRight" ? { source_time: point.source_time + (event.key === "ArrowRight" ? 1 : -1) * (fine ? .002 : .01) } : { delta_semitones: point.delta_semitones + (event.key === "ArrowUp" ? 1 : -1) * (fine ? .02 : .1) };
        this.changeCurvePoint(index, change); this.checkpoint(before);
      });
      this.curvePointLayer.append(handle); this.curvePointElements.push(handle);
    }
    for (let i = 0; i < points.length; i++) {
      const point = points[i], handle = this.curvePointElements[i], word = this.wordAtTime(point.source_time), selected = i === this.selectedPoint;
      handle.style.left = `${this.sourceToX(point.source_time)}px`; handle.style.top = `${this.pitchToY(this.pitch() + point.delta_semitones)}px`;
      handle.classList.toggle("ds-point-selected", selected); handle.classList.toggle("ds-point-word-selected", word?.id === this.selected);
      handle.classList.toggle("ds-point-invalid", Math.abs(point.delta_semitones + this.pitch()) > 3);
      handle.setAttribute("aria-label", `Pitch point ${i + 1}, ${word?.text || "Speech"}, Source ${point.source_time.toFixed(3)} s`);
      handle.setAttribute("aria-valuenow", String(this.pitch() + point.delta_semitones)); handle.setAttribute("aria-valuetext", `Total ${(point.delta_semitones + this.pitch()).toFixed(2)} st, local ${point.delta_semitones.toFixed(2)} semitones`);
      handle.title = `“${word?.text || ""}” ${point.source_time.toFixed(3)} s · Total ${(this.pitch() + point.delta_semitones).toFixed(2)} semitones\nDrag vertically for pitch, horizontally for time; Delete removes the point`;
      handle.disabled = this.busy || (!!this.drag && this.drag.kind !== "curve");
    }
    const active = points[this.selectedPoint]; this.curveTooltip.hidden = !active || this.drag?.kind !== "curve";
    if (active) {
      this.curveTooltip.textContent = `${active.source_time.toFixed(3)} s · Total ${(this.pitch() + active.delta_semitones).toFixed(2)} semitones`;
      this.curveTooltip.style.left = `${limit(this.sourceToX(active.source_time), 80, Math.max(80, width - 85))}px`;
    }
    this.updateContextPlayhead();
  },
updateCurveControls() {
    if (!this.curveAddButton) return;
    const point = this.curve()[this.selectedPoint], disabled = this.busy || !!this.drag || !!this.realPitchMode;
    this.curveAddButton.disabled = disabled || this.curve().length >= CURVE_MAX_POINTS;
    this.curveDeleteButton.disabled = disabled || !point; this.curveClearButton.disabled = disabled || !this.curve().length;
    this.curveExpandButton.disabled = this.busy || !!this.drag; this.curveResizer.disabled = this.busy || (!!this.drag && this.drag.kind !== "curve-height");
    this.curveTimeInput.disabled = disabled || !point; this.curvePitchInput.disabled = disabled || !point;
    this.curveTimeInput.max = String(this.sourceDuration); this.curveTimeInput.value = point ? point.source_time.toFixed(3) : ""; this.curvePitchInput.value = point ? (this.pitch() + point.delta_semitones).toFixed(2) : "";
    this.curveResizer.setAttribute("aria-valuenow", String(this.curveHeight));
    this.curveExpandButton.textContent = this.curveHeight < 100 ? "Expand curve" : "Collapse curve";
    this.curveModeNote.textContent = this.realPitchMode ? "Gray: source · Gold: target · Green: measured output. Shaded areas are unreliable." : this.curve().length === 1 ? "One point shifts the entire line" : "Total shift · 0 preserves source pitch";
  },
updateContextPlayhead(id = null) {
    if (!this.curvePlayhead || !this.document) return;
    const card = id ? this.audio[id] : Object.values(this.audio).find(item => !item.player.paused);
    if (card) {
      let time = card.player.currentTime;
      if (card === this.audio.result) {
        const result = this.line().last_result;
        if (Array.isArray(result?.curve) && result.curve.length > 1) {
          const points = result.curve.map(point => [point.time, point.multiplier]);
          let a = 0, b = this.sourceDuration;
          for (let i = 0; i < 30; i++) { const mid = (a + b) / 2; if (mappedSourceTime(mid, points) < time) a = mid; else b = mid; }
          time = (a + b) / 2;
        } else if (result?.duration) time *= this.sourceDuration / result.duration;
      }
      this.playingSourceTime = limit(time, 0, this.sourceDuration);
    }
    this.curvePlayhead.hidden = this.playingSourceTime === null;
    if (this.playingSourceTime !== null) {
      this.curvePlayhead.style.left = `${this.sourceToX(this.playingSourceTime)}px`;
      this.curvePlayhead.style.height = `${this.curveHeight + 53}px`;
    }
  },
animatePlayback() {
    if (this.playbackFrame !== null) window.cancelAnimationFrame(this.playbackFrame);
    const tick = () => {
      this.playbackFrame = null; this.updateContextPlayhead();
      if (Object.values(this.audio).some(card => !card.player.paused)) this.playbackFrame = window.requestAnimationFrame(tick);
    };
    this.playbackFrame = window.requestAnimationFrame(tick);
  }
};
