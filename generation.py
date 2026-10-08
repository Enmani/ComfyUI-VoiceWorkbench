"""Run trusted, separately configured speech engines and alignment workers."""
import json
import os
import shutil
import sys
from pathlib import Path
from . import configuration


def generate(request_path, run_process):
    folder = request_path.parent
    req = json.loads(request_path.read_text(encoding='utf-8'))
    name = req['options']['engine']
    config = configuration.engine_config(name)
    env = {**os.environ, 'PYTHONUTF8':'1', 'HF_HUB_DISABLE_TELEMETRY':'1',
           'VOICE_WORKBENCH_ENGINE_CONFIG':json.dumps(config)}
    worker = {'System':'system_worker.py', 'IndexTTS2':'index_worker.py', 'AuK':'auk_worker.py'}[name]
    if name != 'System' and not configuration.read().get('aligner'):
        raise ValueError('Configure the Qwen3 forced aligner before generating AI takes. See docs/engines.md.')
    run_process([config.get('python', configuration.python()), '-B',
                 str(configuration.ROOT/'workers'/worker), str(request_path)],
                folder, 'generation.log', env)
    if not (folder/'aligned.json').is_file():
        aligner = configuration.read().get('aligner', {})
        if not aligner:
            raise ValueError('This speech engine needs a configured forced aligner. The generated WAV is retained.')
        env['VOICE_WORKBENCH_ALIGNER_CONFIG'] = json.dumps(aligner)
        run_process([aligner.get('python', sys.executable), '-B',
                     str(configuration.ROOT/'workers/align_worker.py'), str(request_path)],
                    folder, 'alignment.log', env)
    if name == 'AuK':
        verifier = configuration.read().get('verifier')
        if verifier:
            env['VOICE_WORKBENCH_VERIFIER_CONFIG'] = json.dumps(verifier)
            run_process([verifier.get('python', sys.executable), '-B',
                         str(configuration.ROOT/'workers/verify_worker.py'), str(request_path)],
                        folder, 'verification.log', env)


def normalize_text(text):
    return ''.join(char.lower() for char in text if char.isalnum())
