"""Optional Qwen3 forced alignment in its own Transformers environment."""
import json
import os
import sys
from pathlib import Path
CONFIG = json.loads(os.environ['VOICE_WORKBENCH_ALIGNER_CONFIG'])
ALIGN_MODEL = Path(CONFIG['model'])
def save_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2), encoding='utf-8')

def _valid_alignment(words, duration, allow_zero=False):
    import math
    previous = 0.
    if not words:
        return False
    for word in words:
        start, end = float(word['start_time']), float(word['end_time'])
        if (not math.isfinite(start+end) or start < previous-1e-6 or start < 0
                or end > duration+1e-6 or end < start or (end == start and not allow_zero)):
            return False
        previous = end
    return True


def _recover_alignment(decode, duration, time_step=.08):
    raw = decode(0.)
    result = {'words': raw, 'analysis_only_padding_seconds': 0., 'audio_unchanged': True}
    # The classifier quantizes timestamps. A short syllable can occupy the same
    # bin at both ends. Shift only the analysis grid and rerun the official model;
    # never invent a word span, change the WAV, or accept overlapping timestamps.
    if not _valid_alignment(raw, duration) and _valid_alignment(raw, duration, allow_zero=True):
        result['raw_words'] = raw
        for padding in (time_step/2, time_step*1.5):
            words = decode(padding)
            if _valid_alignment(words, duration):
                result.update(words=words, analysis_only_padding_seconds=padding)
                break
    return result


def align(request):
    import torch
    import soundfile as sf
    from transformers import AutoProcessor, AutoModelForTokenClassification
    if not (ALIGN_MODEL / "model.safetensors").is_file() or (ALIGN_MODEL / "model.safetensors.aria2").exists():
        raise RuntimeError("Forced-aligner weights are incomplete. Generated audio is retained.")
    os.environ["HF_HUB_OFFLINE"] = "1"
    torch.set_num_threads(6)
    processor = AutoProcessor.from_pretrained(str(ALIGN_MODEL), local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(str(ALIGN_MODEL), dtype=torch.float32,
                                                            device_map="cpu", local_files_only=True)
    model.eval()
    wave, sr = sf.read(request["audio"], dtype="float32")
    if wave.ndim > 1:
        wave = wave.mean(axis=1)
    duration = len(wave)/sr
    if sr != 16000:
        import math
        from scipy.signal import resample_poly
        factor = math.gcd(sr, 16000)
        wave = resample_poly(wave, 16000 // factor, sr // factor)
    def decode(padding):
        import numpy as np
        analysis_wave = np.pad(wave, (round(padding*16000), 0)) if padding else wave
        inputs, word_lists = processor.prepare_forced_aligner_inputs(audio=analysis_wave, transcript=request["text"], language=CONFIG.get("language", "English"))
        inputs = inputs.to(model.device, model.dtype)
        with torch.inference_mode():
            out = model(**inputs)
        words = processor.decode_forced_alignment(logits=out.logits, input_ids=inputs["input_ids"],
                                                 word_lists=word_lists, timestamp_token_id=model.config.timestamp_token_id)[0]
        if padding:
            for word in words:
                word['start_time'] = round(word['start_time']-padding, 6)
                word['end_time'] = round(word['end_time']-padding, 6)
        return words
    result = _recover_alignment(decode, duration, processor.timestamp_segment_time/1000.)
    if not _valid_alignment(result["words"], duration):
        raise ValueError("Forced alignment failed. Generated audio is retained.")
    for i, word in enumerate(result["words"]):
        word["id"] = f"w{i}"
    save_json(request["output"], {**result, "model": str(ALIGN_MODEL), "device": "cpu"})

if __name__ == '__main__':
    path = Path(sys.argv[1])
    req = json.loads(path.read_text(encoding='utf-8'))
    align({'audio':str(path.parent/'voice.wav'), 'text':req['text'], 'output':str(path.parent/'aligned.json')})
