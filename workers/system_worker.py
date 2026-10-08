"""Quick-start system speech. Windows word starts come from SAPI events."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
import soundfile as sf


def save(path, data):
    path.write_text(json.dumps(data, indent=2, allow_nan=False), encoding='utf-8')


def main():
    path = Path(sys.argv[1]).resolve()
    req = json.loads(path.read_text(encoding='utf-8'))
    folder = path.parent
    if os.name == 'nt':
        subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                        '-File', str(Path(__file__).with_name('system_voice.ps1')), '-Request', str(path)],
                       check=True, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
        marks = json.loads((folder/'speech-marks.json').read_text(encoding='utf-8-sig'))
        info = sf.info(folder/'voice.wav')
        duration = info.duration
        words = []
        for index, mark in enumerate(marks):
            start = float(mark['start_time'])
            end = float(marks[index+1]['start_time']) if index+1 < len(marks) else duration
            if end <= start or not any(char.isalnum() for char in mark['text']):
                raise ValueError('System speech returned unusable word marks. Configure a forced aligner.')
            words.append({'id':f'w{index}', 'text':mark['text'], 'start_time':start, 'end_time':end})
        normalize = lambda text: ''.join(char.lower() for char in text if char.isalnum())
        if not words or normalize(''.join(word['text'] for word in words)) != normalize(req['text']):
            raise ValueError('System speech word marks do not cover the requested text.')
        save(folder/'aligned.json', {'words':words, 'method':'Windows SAPI SpeechProgress',
             'alignment_is_estimated':True, 'end_times':'next word start or recording end'})
    else:
        executable = shutil.which('espeak-ng') or shutil.which('espeak')
        if not executable:
            raise RuntimeError('Install espeak-ng or configure IndexTTS2.')
        subprocess.run([executable, '-v', 'en-us', '-w', str(folder/'voice.wav'), req['text']], check=True, timeout=90)
    info = sf.info(folder/'voice.wav')
    save(folder/'generation.json', {'engine':'System', 'text':req['text'], 'duration':info.duration,
         'sample_rate':info.samplerate, 'segments':1, 'waveform_splicing':False,
         'voice_cloning':False, 'emotion_control':False, 'source':'Operating-system speech synthesizer'})


if __name__ == '__main__':
    main()
