import { BASE, element, request, api } from "./common.js";

export const audioMethods = {
async save(automatic = false) {
    if (this.busy || this.drag || this.textSession || !this.document || this.hasInvalidSettings()) return;
    this.commitPerformanceControls();
    clearTimeout(this.saveTimer);
    if (!this.isDirty()) return;
    this.autoSaving = true; this.autoSaveError = null; this.busy = true; this.updateControls();
    try {
      const data = await request("/save", { path: this.path, document: this.document, base_revision: this.document.revision });
      this.document = data.document; this.savedSignature = this.draftSignature(); this.preserveDraft();
      if (!automatic) this.setStatus("Edits saved. Click Preview to update the audio.", "ok");
      await this.refreshVersions();
    } catch (error) { this.autoSaveError = error.message; this.setStatus(`Save failed: ${error.message}. Edits are retained. Retry saving, or reload after a revision conflict.`, "error"); }
    finally { this.autoSaving = false; this.busy = false; this.refreshEditing(); }
  },
async render() {
    if (this.busy || this.drag || !this.document || this.hasInvalidSettings()) return;
    if (this.textPending()) { await this.generatePerformance(); return; }
    this.pausePlayers(); this.busy = true; this.setStatus("Resynthesizing speed, pitch and timing in one continuous pass…");
    try {
      const data = await request("/render", { path: this.path, document: this.document, base_revision: this.document.revision, line_id: this.line().id });
      this.document = data.document; this.savedSignature = this.draftSignature(); this.preserveDraft();
      this.busy = false; this.build();
      this.setStatus("Preview ready. Compare the original and edited recordings.", "ok");
    } catch (error) { this.setStatus(`Preview failed: ${error.message}. Current edits are retained.`, "error"); }
    finally { this.busy = false; this.updateControls(); }
  },
mediaUrl(path) { return api.apiURL(`${BASE}/media?document=${encodeURIComponent(this.path)}&path=${encodeURIComponent(path)}`); },
audioCard(id, title) {
    const root = element("div", "ds-audio-card"); const heading = element("div", "ds-audio-heading");
    const badge = element("span", "ds-badge", id === "original" ? "Source recording" : "No preview yet"); badge.dataset.tone = "muted";
    heading.append(element("strong", "", title), badge);
    const wrap = element("div", "ds-wave-wrap"); const canvas = element("canvas"); canvas.setAttribute("aria-label", `${title} waveform; click to seek`);
    const empty = element("span", "ds-wave-empty", id === "original" ? "Loading waveform…" : "Click Preview to hear the edited recording"); wrap.append(canvas, empty);
    const player = element("audio"); player.controls = true; player.preload = "metadata";
    player.setAttribute("aria-label", `${title}Audio player`);
    player.addEventListener("play", () => { this.pausePlayers(player); this.animatePlayback(); });
    player.addEventListener("timeupdate", () => { this.drawWave(id); this.updateContextPlayhead(id); });
    player.addEventListener("seeked", () => this.updateContextPlayhead(id));
    player.addEventListener("loadedmetadata", () => {
      if (id === "original" && Number.isFinite(player.duration)) { this.sourceDuration = player.duration; this.updateTiming(); }
    });
    player.addEventListener("error", () => { empty.textContent = "Audio could not be loaded. Check the file or reopen the document."; empty.hidden = false; });
    canvas.addEventListener("click", event => {
      if (Number.isFinite(player.duration)) player.currentTime = Math.max(0, Math.min(player.duration, (event.clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width * player.duration));
    });
    root.append(heading);
    if (this.textPending()) root.append(element("p", "ds-muted", `Recording text: ${this.line().text}`));
    root.append(wrap, player); this.audio[id] = { root, badge, canvas, empty, player, data: null };
    return root;
  },
pausePlayers(except = null) { for(const player of [this.performancePlayer,this.versionCurrentPlayer,this.versionSelectedPlayer]) if(player&&player!==except)player.pause(); for (const card of Object.values(this.audio || {})) if(card.player !== except) card.player.pause(); if (this.playbackFrame !== null) window.cancelAnimationFrame(this.playbackFrame); this.playbackFrame = null; },
async waveform(url) {
    if (!this.peaks.has(url)) this.peaks.set(url, (async () => {
      const response = await fetch(url); if (!response.ok) throw new Error("Cannot read waveform");
      const AudioContextType = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextType) throw new Error("This browser does not support waveform display");
      const context = new AudioContextType();
      try {
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const channel = buffer.getChannelData(0); const peaks = new Float32Array(1600);
        for (let i = 0; i < peaks.length; i++) {
          const start = Math.floor(i / peaks.length * channel.length); const end = Math.max(start + 1, Math.floor((i + 1) / peaks.length * channel.length));
          let value = 0; for (let j = start; j < end; j++) value = Math.max(value, Math.abs(channel[j] || 0)); peaks[i] = value;
        }
        return { peaks, duration: buffer.duration };
      } finally { await context.close(); }
    })());
    return this.peaks.get(url);
  },
loadAudio() {
    const ticket = ++this.loadCounter; const line = this.line();
    for (const [id, path] of [["original", line.audio_path], ["result", line.last_result?.audio]]) {
      const card = this.audio[id]; if (!path) { card.player.hidden = true; continue; }
      const url = this.mediaUrl(typeof path === "object" ? path.path : path); card.player.src = url; card.player.hidden = false;
      this.waveform(url).then(data => {
        if (ticket !== this.loadCounter) return;
        card.data = data; card.empty.hidden = true; this.drawWave(id);
      }).catch(error => { if (ticket === this.loadCounter) { card.empty.textContent = error.message; card.empty.hidden = false; } });
    }
    this.waveObserver = new ResizeObserver(() => this.drawWaves());
    for (const card of Object.values(this.audio)) this.waveObserver.observe(card.canvas);
    this.updateControls();
  },
drawWaves() { for (const id of Object.keys(this.audio)) this.drawWave(id); },
drawWave(id) {
    const card = this.audio[id]; if (!card?.data) return;
    const width = card.canvas.clientWidth; const height = card.canvas.clientHeight; if (!width || !height) return;
    const scale = window.devicePixelRatio || 1; card.canvas.width = Math.round(width * scale); card.canvas.height = Math.round(height * scale);
    const ctx = card.canvas.getContext("2d"); if (!ctx) return; ctx.scale(scale, scale); ctx.clearRect(0, 0, width, height);
    const word = id === "original" ? this.word() : this.line().last_result?.words?.find(word => word.id === this.selected);
    if (word && Number.isFinite(word.start_time) && Number.isFinite(word.end_time)) {
      ctx.fillStyle = "rgba(125,227,205,.10)"; ctx.fillRect(word.start_time / card.data.duration * width, 0, (word.end_time - word.start_time) / card.data.duration * width, height);
    }
    ctx.strokeStyle = "#3d5059"; ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
    ctx.strokeStyle = id === "result" && this.isResultStale() ? "#b99c6e" : id === "original" ? "#8eacb5" : "#7de3cd";
    ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < width; x += 2) {
      const index = Math.floor(x / width * card.data.peaks.length); const amplitude = Math.max(1, card.data.peaks[index] * height * .46);
      ctx.moveTo(x, height / 2 - amplitude); ctx.lineTo(x, height / 2 + amplitude);
    }
    ctx.stroke();
    if (card.player.currentTime > 0) { const x = card.player.currentTime / card.data.duration * width; ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  },
onKey(event) {
    if (!(event.ctrlKey || event.metaKey) || this.busy || this.drag) return;
    const input = event.target.closest("input,textarea,select");
    if (event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); this.save(); }
    else if (!input && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopPropagation(); event.shiftKey ? this.redo() : this.undo(); }
    else if (!input && event.key.toLowerCase() === "y") { event.preventDefault(); event.stopPropagation(); this.redo(); }
  }
};
