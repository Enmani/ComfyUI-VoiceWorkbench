import { app, api } from "./host.js";
export { app, api };
const TAB_ID = "voice-workbench";
const NODE_TYPE = "VWVoiceEditor";
const BASE = "/voice-workbench";
const DRAG_PIXELS_PER_SECOND = 600;
const BACKEND_VERSION = "0.5.0";
const SPEED_RANGE = [.75, 1.25];
const PITCH_RANGE = [-3, 3];
const CURVE_MIN_GAP = .02;
const CURVE_MAX_POINTS = 64;
const copy = (value) => JSON.parse(JSON.stringify(value));
const seconds = (value, digits = 2) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)} s` : "—";
const cleanEdits = (edits = []) => edits.filter(e => Number(e.extra_seconds) > 0)
  .map(e => ({ word_id: String(e.word_id), extra_seconds: Math.round(Number(e.extra_seconds) * 1000) / 1000 }))
  .sort((a, b) => a.word_id.localeCompare(b.word_id));
const cleanCurve = (points = []) => points.map(point => ({ source_time: Number(point.source_time), delta_semitones: Number(point.delta_semitones) })).sort((a, b) => a.source_time - b.source_time);
const cleanTiming = (edits = []) => edits.filter(e => Number(e.delta_seconds) !== 0).map(e => ({segment_id:String(e.segment_id),delta_seconds:Number(e.delta_seconds)})).sort((a,b)=>a.segment_id.localeCompare(b.segment_id));
const lineSettings = (line = {}) => ({ performance_options: copy(line.performance_options || {direction:"Calm and restrained, asking gently",strength:.65}), tail_target: line.tail_target ? copy(line.tail_target) : null, edits: cleanEdits(line.edits), timing_edits: cleanTiming(line.timing_edits), speed: Number(line.speed ?? 1), pitch_semitones: Number(line.pitch_semitones ?? 0), pitch_curve: cleanCurve(line.pitch_curve), ...((line.draft_text ?? line.text) !== undefined ? { draft_text: line.draft_text ?? line.text } : {}) });
const settingsSignature = (line) => { const { draft_text, performance_options, ...controls } = lineSettings(line); return JSON.stringify(controls); };
const limit = (value, min, max) => Math.min(max, Math.max(min, value));
function maxExtra(word, speed = 1) {
  if (!word?.editable) return 0;
  const capacity = Number(word.duration_capacity ?? (Number(word.sustain_end) - Number(word.sustain_start)) * .75);
  return Math.max(0, Math.floor((Math.min(.20, capacity * (2.5 - 1 / speed)) + 1e-9) * 100) / 100);
}
const nodeWidget = (node, name) => node.widgets?.find(w => w.name === name)?.value;

// Shape-preserving cubic interpolation, matching scipy PchipInterpolator.
// Endpoint values hold outside the first/last control point.
function curveValue(points, time) {
  if (!points.length) return 0;
  if (points.length === 1 || time <= points[0].source_time) return points[0].delta_semitones;
  const n = points.length;
  if (time >= points[n - 1].source_time) return points[n - 1].delta_semitones;
  const h = [], d = [], slopes = Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(points[i + 1].source_time - points[i].source_time); d.push((points[i + 1].delta_semitones - points[i].delta_semitones) / h[i]); }
  if (n === 2) slopes[0] = slopes[1] = d[0];
  else {
    const endpoint = (h0, h1, d0, d1) => {
      let value = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(value) !== Math.sign(d0)) value = 0;
      else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(value) > Math.abs(3 * d0)) value = 3 * d0;
      return value;
    };
    slopes[0] = endpoint(h[0], h[1], d[0], d[1]);
    slopes[n - 1] = endpoint(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    for (let i = 1; i < n - 1; i++) {
      if (!d[i - 1] || !d[i] || Math.sign(d[i - 1]) !== Math.sign(d[i])) continue;
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      slopes[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  const i = points.findIndex((point, index) => index < n - 1 && time < points[index + 1].source_time);
  const s = (time - points[i].source_time) / h[i], s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * points[i].delta_semitones + (s3 - 2 * s2 + s) * h[i] * slopes[i] + (-2 * s3 + 3 * s2) * points[i + 1].delta_semitones + (s3 - s2) * h[i] * slopes[i + 1];
}

function mappedSourceTime(time, points) {
  let result = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [a, av] = points[i], [b, bv] = points[i + 1];
    if (time <= a) break;
    const span = Math.min(time, b) - a;
    result += av * span + .5 * (bv - av) * span * span / (b - a);
    if (time <= b) break;
  }
  return result;
}
function mapAnchors(anchors, value, inverse = false) {
  const pairs = inverse ? anchors.map(point => [point[1], point[0]]) : anchors;
  if (value <= pairs[0][0]) return pairs[0][1];
  for (let i = 1; i < pairs.length; i++) {
    if (value <= pairs[i][0]) {
      const [a, av] = pairs[i - 1], [b, bv] = pairs[i];
      return av + (bv - av) * (b === a ? 0 : (value - a) / (b - a));
    }
  }
  return pairs[pairs.length - 1][1];
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, onClick, className = "") {
  const el = element("button", className, text);
  el.type = "button";
  el.addEventListener("click", onClick);
  return el;
}
async function request(route, body) {
  const response = await api.fetchApi(BASE + route, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Cannot read server response (${response.status})`); }
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}


export { TAB_ID, NODE_TYPE, BASE, DRAG_PIXELS_PER_SECOND, BACKEND_VERSION, SPEED_RANGE, PITCH_RANGE, CURVE_MIN_GAP, CURVE_MAX_POINTS, copy, seconds, cleanEdits, cleanCurve, cleanTiming, lineSettings, settingsSignature, limit, maxExtra, nodeWidget, curveValue, mappedSourceTime, mapAnchors, element, button, request };
