"""Independent transcript recognition for whole-recording voice editing."""
import json
import math
import os
import sys
from pathlib import Path
import soundfile as sf
from scipy.signal import resample_poly
CONFIG = json.loads(os.environ['VOICE_WORKBENCH_VERIFIER_CONFIG'])
if CONFIG.get('module_path'):
    sys.path.insert(0, CONFIG['module_path'])
import sherpa_onnx


def main():
    path = Path(sys.argv[1])
    req = json.loads(path.read_text(encoding='utf-8'))
    config = CONFIG
    model = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=config['model'],tokens=config['tokens'],
        language=config.get('language','en'), use_itn=False, num_threads=2, provider='cpu')
    wave, sr = sf.read(path.parent/'voice.wav', dtype='float32')
    if wave.ndim > 1:
        wave = wave.mean(axis=1)
    if sr != 16000:
        divisor = math.gcd(sr,16000)
        wave = resample_poly(wave,16000//divisor,sr//divisor)
    stream = model.create_stream()
    stream.accept_waveform(16000,wave)
    model.decode_stream(stream)
    actual = stream.result.text
    normalize = lambda value: ''.join(char.lower() for char in value if char.isalnum())
    result = {'expected':req['text'], 'recognized':actual,
              'text_match':normalize(actual)==normalize(req['text']),
              'note':'Automatic transcript check. Listen before accepting.'}
    (path.parent/'verification.json').write_text(json.dumps(result,indent=2),encoding='utf-8')


if __name__ == '__main__':
    main()
