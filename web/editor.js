import { element } from "./common.js";
import { stateMethods } from "./state.js";
import { viewMethods } from "./view.js";
import { performanceMethods } from "./performance.js";
import { pitchMethods } from "./pitch.js";
import { timingMethods } from "./timing.js";
import { audioMethods } from "./audio.js";

export class ProsodyEditor {
constructor() {
    this.host = null; this.root = null; this.path = null; this.document = null; this.boundNode = null;
    this.selected = null; this.busy = false; this.drag = null; this.undoStack = []; this.redoStack = [];
    this.savedSignature = ""; this.message = ""; this.messageTone = "";
    this.audio = {}; this.peaks = new Map(); this.sourceDuration = null; this.loadCounter = 0;
    this.waveObserver = null; this.portalObserver = null; this.expanded = false;
    this.curveObserver = null; this.curveHeight = 135; this.pixelsPerSecond = 400; this.selectedPoint = null; this.playingSourceTime = null; this.playbackFrame = null;
    this.onWindowKey = event => {
      if (event.key !== "Escape") return;
      if (this.drag) { event.preventDefault(); event.stopPropagation(); this.finishDrag(true); }
      else if (this.expanded) { event.preventDefault(); event.stopPropagation(); this.setExpanded(false); }
    };
    window.addEventListener("keydown", this.onWindowKey);
  }
}
Object.assign(ProsodyEditor.prototype, stateMethods, viewMethods, performanceMethods, pitchMethods, timingMethods, audioMethods);
