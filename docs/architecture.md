# Architecture

`web/editor.js` composes the editor's state, view, pitch, timing, performance and audio methods. `web/common.js` holds shared control semantics, including the source-time PCHIP interpolator. `web/host.js` supplies the real ComfyUI or standalone API adapter. `web/comfy.js` registers the bottom panel and node button; `demo/bootstrap.js` mounts the same editor directly.

`prosody_routes.py` registers the same HTTP handlers with either host. ComfyUI owns its generation queue. `run.py` owns a bounded, serial standalone queue. A generation request produces a candidate; it never silently replaces the current take.

`prosody_service.py` validates paths, revisions and control bounds, writes JSON atomically, and runs CPU analysis/resynthesis in a short-lived process. Source audio must remain inside the selected job. Size and modification time identify revisions; no hashes are computed. Stale revisions return HTTP 409.

`workers/analysis.py` measures continuous voicing, pitch and existing near-silence. `workers/resynthesis.py` builds one DurationTier and optional PitchTier, then performs one whole-utterance overlap-add resynthesis. Both layers validate limits. Invalid samples or clipping stop export.

`performance_service.py` stores immutable candidates and snapshots, verifies source/text compatibility on adoption, and restores complete line state. Adopting regenerated speech clears local anchors tied to the previous waveform. AuK takes bake the audible input controls and reset those controls when applied.

`generation.py` starts configured model workers using argument arrays without a shell. Executable and model paths come only from trusted machine configuration. AI models and the forced aligner have separate environments; model weights are never stored in repository jobs. AuK transcript verification is an independent recognition step: forced alignment alone cannot validate content.

## Workspace layout

```text
jobs/<name>/
  request.md
  prosody.json
  assets/voice.wav
  logs/
  outputs/prosody/<take>/line-1.wav
  outputs/performances/<take>/
    request.json
    status.json
    voice.wav
    aligned.json
    candidate.json
  outputs/performance-versions/<snapshot>.json
```

Recordings are immutable. Previews, candidates and versions are separate files. Browser session drafts are rebased only onto a matching source/alignment; they cannot silently overwrite a changed recording.
