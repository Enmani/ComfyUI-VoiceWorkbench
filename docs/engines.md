# Local engines

Copy [config.example.json](../config.example.json) to `config.json` and replace paths with your installations. Install each model using its official repository instructions and license. The workbench does not install or fetch model weights.

## System voice

Windows uses `System.Speech` with an installed English voice. Word starts come from `SpeechProgress` events; ends are estimated from the next word or recording end and refined for near-silence. Output is explicitly 16 kHz mono PCM so event times match audio time.

Linux/macOS can use an installed `espeak-ng` or `espeak`, plus the configured forced aligner. The bundled default recording and all CPU editing functions work without a speech engine. System speech ignores emotion direction and does not clone the reference.

## IndexTTS2

- Official source: [index-tts/index-tts](https://github.com/index-tts/index-tts).
- `python`: its environment's Python executable.
- `repository`: the installed repository containing `indextts`.
- `model`: the complete IndexTTS2 model directory containing `config.yaml`.
- `root`: its cache/runtime root.
- This adapter expects the local-path `aux_paths` support used by the installed IndexTTS2 `infer_v2.py`. Its auxiliary weights reside under `<model>/hf_cache`: `w2v-bert-2.0`, `semantic_codec_model.safetensors`, `campplus_cn_common.bin`, and `bigvgan`.

The eight-class QwenEmotion analyzer maps direction into a conservative emotion vector. It unloads before acoustic synthesis. A line must fit one 200-token segment; no waveform concatenation is used. The tested installation uses CUDA, FP16 and no DeepSpeed, custom CUDA kernel or Torch compilation.

## Qwen3 forced alignment

- Source/model: [Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B).
- `aligner.python`: a separate environment with the Hugging Face native Qwen3 forced-alignment processor/model API, Torch, SoundFile and SciPy. The tested environment uses Transformers 5.15.1.
- `aligner.model`: local model directory.
- `aligner.language`: `English` for the default case.

The worker runs on CPU and requires `prepare_forced_aligner_inputs`, `decode_forced_alignment`, and `AutoModelForTokenClassification`. Quantized zero-length timestamps can be retried with an analysis-only grid offset; the audio is unchanged. Invalid or overlapping results are rejected.

## AuK Base

- Official source: [Tencent-Hunyuan/AuK](https://github.com/Tencent-Hunyuan/AuK).
- `repository` contains `src/auk`; `model` contains `config.yaml` and `auk_base.safetensors`.
- `qwen_model` points to the installed Qwen2.5-Omni-3B weights.
- Target duration is 0 to retain the audible take's duration, or 0.15–15 seconds.

The adapter stages speech understanding and synthesis sequentially with CPU offload. It edits the complete audible input, including its preview controls. A configured `verifier` is required to apply an AuK take. Without matching recognition, the generated recording remains preview-only; previous audio is preserved.

`verifier` uses a local SenseVoice model through `sherpa-onnx`; set its Python environment, ONNX model and tokens file. If that environment stores add-on packages outside site-packages, set the optional `module_path` to their directory. English comparison ignores punctuation and letter case. Recognition may reject correct speech; listen and regenerate rather than bypassing a mismatch.

The AuK adapter is retained from the local workbench but has not been exercised against an English take in this public release. IndexTTS2 and the default CPU/system-speech flow have separate validation records.
