"""Machine configuration. Never accept executable/model paths from HTTP requests."""
import json
import os
import sys
import subprocess
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read():
    path = Path(os.environ.get('VOICE_WORKBENCH_CONFIG', ROOT / 'config.json'))
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}


def workspace():
    configured = os.environ.get('VOICE_WORKBENCH_HOME') or read().get('workspace')
    return Path(configured).expanduser().resolve() if configured else Path.home() / '.voice-workbench'


def engine_config(name):
    config = read().get('engines', {}).get(name, {})
    if name != 'System' and not config:
        raise ValueError(f'{name} is not configured. See docs/engines.md.')
    return config


def python():
    return read().get('prosody_python', sys.executable)


@lru_cache(maxsize=1)
def windows_speech_available():
    if os.name != 'nt':
        return False
    command = ('Add-Type -AssemblyName System.Speech; '
               '$speech=New-Object System.Speech.Synthesis.SpeechSynthesizer; '
               '@($speech.GetInstalledVoices() | Where-Object { $_.Enabled -and '
               '$_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq "en" }).Count -gt 0; $speech.Dispose()')
    try:
        result = subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command],
                                capture_output=True,text=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
        return result.returncode == 0 and result.stdout.strip().lower() == 'true'
    except (OSError,subprocess.TimeoutExpired):
        return False


def engines():
    import shutil
    return [
        {'id': 'System', 'label': 'System voice · Quick start',
         'available': windows_speech_available() if os.name == 'nt' else
             bool((shutil.which('espeak-ng') or shutil.which('espeak')) and read().get('aligner'))},
        *[{'id': name, 'label': label, 'available': bool(read().get('engines', {}).get(name))}
          for name, label in [('IndexTTS2', 'IndexTTS2 · Voice & emotion'), ('AuK', 'AuK Base · Edit current recording')]],
    ]
