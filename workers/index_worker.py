"Whole-line IndexTTS2 performance; short-lived isolated GPU process.\n\nUses emotionTTS_remake's reference + eight-emotion-vector workflow and the\nofficial IndexTTS2 API. Reference selection is fixed for voice consistency.\nNo waveform segmentation, concatenation or pitch postprocessing here.\n"
import json
import os
import sys
import time
from pathlib import Path


CONFIG = json.loads(os.environ['VOICE_WORKBENCH_ENGINE_CONFIG'])
ROOT = Path(CONFIG['root']).expanduser().resolve()
os.environ.update(HF_HOME=str(ROOT/'cache/huggingface'), HF_HUB_OFFLINE='1',
    TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', TORCH_HOME=str(ROOT/'cache/torch'),
    XDG_CACHE_HOME=str(ROOT/'cache'), MPLCONFIGDIR=str(ROOT/'cache/matplotlib'))
sys.path.insert(0, str(Path(CONFIG['repository'])))


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)


def main():
    started = time.monotonic()
    request_path = Path(sys.argv[1]).resolve()
    req = json.loads(request_path.read_text(encoding='utf-8-sig'))
    folder = request_path.parent
    def progress(message):
        save(folder / 'status.json', {'state': 'running', 'message': message})
    progress('Loading the speech model')
    import numpy as np
    import random
    import torch
    import soundfile as sf
    from indextts.infer_v2 import IndexTTS2
    torch.set_num_threads(6)
    if not torch.cuda.is_available():
        raise RuntimeError('IndexTTS2 requires a local NVIDIA GPU.')
    seed = int(req['seed'])
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    model = Path(CONFIG['model'])
    aux = model / 'hf_cache'
    engine = IndexTTS2(cfg_path=str(model/'config.yaml'), model_dir=str(model),
                      device='cuda:0', use_fp16=True, use_cuda_kernel=False,
                      use_deepspeed=False, use_accel=False, use_torch_compile=False,
                      use_qwen_emo=True,
                      aux_paths={'w2v_bert': str(aux/'w2v-bert-2.0'),
                                 'semantic_codec': str(aux/'semantic_codec_model.safetensors'),
                                 'campplus': str(aux/'campplus_cn_common.bin'),
                                 'bigvgan': str(aux/'bigvgan')})
    progress('Analysing performance direction')
    # Use the engine's trained emotion classifier, rather than requiring a
    # second large general-purpose LLM to coexist with ComfyUI on the GPU.
    direction = req['options']['direction'].strip() or req['text']
    scores = engine.qwen_emo.inference(direction)
    names = ['happy','angry','sad','afraid','disgusted','melancholic','surprised','calm']
    raw = [float(scores[name]) for name in names]
    if not all(np.isfinite(v) and v >= 0 for v in raw) or sum(raw) <= 0:
        raise RuntimeError('Emotion analysis returned invalid scores. Try another direction.')
    # Conservative total strength; avoids stacking eight strong emotions.
    strength = float(req['options']['strength'])
    vector = [round(v/sum(raw)*strength, 5) for v in raw]
    save(folder/'emotion-plan.json', {'analyzer': 'IndexTTS2 QwenEmotion',
         'direction': direction, 'names': names, 'raw_scores': raw,
         'emo_vector': vector, 'strength': strength,
         'reference': req['reference'], 'fixed_reference': True,
         'note': 'Emotion classification does not guarantee laughs, sighs or exact duration.'})
    # The trained classifier is no longer needed during acoustic generation.
    del engine.qwen_emo
    engine.qwen_emo = None
    import gc
    gc.collect()
    torch.cuda.empty_cache()
    text_tokens = engine.tokenizer.tokenize(req['text'])
    if len(text_tokens) > 200:
        raise ValueError('A take supports at most 200 speech-text tokens. Shorten the line.')
    segments = engine.tokenizer.split_segments(text_tokens, 200)
    if len(segments) != 1:
        raise ValueError('This line needs segmentation. Use a shorter complete sentence.')
    progress('Generating a complete line from the reference voice')
    sampling = {'max_mel_tokens':1600, 'do_sample':True, 'top_p':.8,
                'top_k':30, 'temperature':.8}
    synthesis_started = time.monotonic()
    engine.infer(spk_audio_prompt=req['reference'], text=req['text'],
                 output_path=str(folder/'voice.wav'), emo_vector=vector,
                 emo_alpha=1.0, use_random=False, interval_silence=0,
                 max_text_tokens_per_segment=200,
                 **sampling, verbose=False)
    synthesis_seconds = time.monotonic()-synthesis_started
    wave, sr = sf.read(folder/'voice.wav')
    if not len(wave) or not np.all(np.isfinite(wave)) or len(wave)/sr > 30:
        raise RuntimeError('Generated audio is invalid or too long. Previous recording retained.')
    save(folder/'generation.json', {'engine': 'IndexTTS2', 'seed': seed,
         'reference': req['reference'], 'text': req['text'], 'options': req['options'],
         'emo_vector': vector, 'sample_rate': sr, 'duration': len(wave)/sr,
         'segments': 1, 'waveform_splicing': False,
         'sampling':sampling, 'inference_options':{'use_random':False,'emo_alpha':1.0,
             'max_text_tokens_per_segment':200,'interval_silence':0,'use_fp16':True,
             'use_cuda_kernel':False,'use_deepspeed':False,'use_accel':False,'use_torch_compile':False},
         'synthesis_seconds':round(synthesis_seconds,3),
         'worker_seconds':round(time.monotonic()-started,3),
         'runtime_configuration':{'engine': CONFIG.get('version', 'user-configured')},
         'source': 'https://github.com/index-tts/index-tts',
         'workflow_reference': 'https://github.com/mmletgo/emotionTTS_remake'})


if __name__ == '__main__':
    main()
