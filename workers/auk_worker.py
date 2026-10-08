'Short-lived AuK Base worker. Official whole-utterance API; no splicing.'
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
sys.path.insert(0, str(Path(CONFIG['repository']) / 'src'))


def save(path,value):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temp,path)

def stage_models(engine, torch, progress):
    'Run the official stages sequentially on a 24 GB GPU, preserving dtypes.'
    engine.device='cuda:0'
    engine.vae_model.to(engine.device)
    # Only CFM's fusion parameters belong on GPU during both stages.
    # Moving the parent module would also load both large children together.
    for parameter in engine.model.parameters(recurse=False):
        parameter.data=parameter.data.to(engine.device)
    for name, buffer in engine.model.named_buffers(recurse=False):
        setattr(engine.model,name,buffer.to(engine.device))
    encode_text=engine.model.encode_text
    def staged_encode(cond_inputs,device):
        progress('AuK is analysing the current voice and direction')
        engine.vae_model.to('cpu');torch.cuda.empty_cache()
        engine.model.text_encoder.to(device)
        try:
            # The surrounding official autocast context otherwise retains every
            # bf16 weight cast alongside the fp32 encoder for this whole stage.
            with torch.autocast('cuda',dtype=engine.dtype,cache_enabled=False):
                result=encode_text(cond_inputs,device)
        finally:
            engine.model.text_encoder.to('cpu')
            # Drop autocast's cached weight casts before loading the DiT.
            torch.clear_autocast_cache();torch.cuda.empty_cache()
        progress('AuK is generating a new performance')
        engine.model.transformer.to(device)
        engine.vae_model.to(device)
        return result
    engine.model.encode_text=staged_encode

def main():
    started=time.monotonic();request=Path(sys.argv[1]);req=json.loads(request.read_text(encoding='utf-8-sig'));folder=request.parent
    def progress(message):save(folder/'status.json',{'state':'running','message':message})
    import torch
    import soundfile as sf
    import numpy as np
    from auk.infer.infer_auk import AukInfer
    if not torch.cuda.is_available():raise RuntimeError('AuK requires a local NVIDIA GPU.')
    torch.set_num_threads(6);seed=int(req['seed']);torch.manual_seed(seed);torch.cuda.manual_seed_all(seed)
    model=Path(CONFIG['model'])
    progress('Loading AuK and its speech-understanding model')
    engine=AukInfer(str(model/'config.yaml'),str(model/'auk_base.safetensors'),
        qwen_path=CONFIG['qwen_model'],device='cpu',dtype='bf16')
    stage_models(engine,torch,progress)
    instruction=req['options']['direction'].strip()+'. Preserve the speaker\'s voice and the spoken words.'
    messages=[{'role':'user','content':[{'type':'text','text':instruction},{'type':'audio','audio':req['reference']}]}]
    progress('AuK is editing the complete performance')
    synthesis=time.monotonic()
    audio,sr=engine.generate(messages,audio=req['reference'],gen_seconds=float(req['target_seconds']),nfe=32,cfg_strength=2.,seed=seed)
    samples=audio.detach().float().cpu().numpy().reshape(-1)
    if not samples.size or not np.isfinite(samples).all():raise RuntimeError('AuK returned invalid audio.')
    # FLOAT WAV avoids silently clipping regenerated samples; no added silence,
    # forced trimming, loudness normalization, or waveform stitching.
    sf.write(folder/'voice.wav',samples,sr,subtype='FLOAT')
    save(folder/'generation.json',{'engine':'AuK','variant':'Base','seed':seed,'reference':req['reference'],
        'text':req['text'],'instruction':instruction,'options':req['options'],'sample_rate':sr,
        'duration':len(samples)/sr,'target_seconds':req['target_seconds'],'baked_controls':True,
        'segments':1,'waveform_splicing':False,'sampling':{'nfe':32,'cfg_strength':2.,'dtype':'bf16'},
        'memory_mode':'sequential_cpu_offload','peak_cuda_allocated_bytes':torch.cuda.max_memory_allocated(),
        'synthesis_seconds':round(time.monotonic()-synthesis,3),'worker_seconds':round(time.monotonic()-started,3),
        'peak':float(np.max(np.abs(samples))),'source':'https://github.com/Tencent-Hunyuan/AuK',
        'runtime_configuration':{'engine': CONFIG.get('version', 'user-configured')}})

if __name__=='__main__':main()
