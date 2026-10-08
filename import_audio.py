"""Import a mono WAV and explicit word timings into a new workspace job."""
import argparse
import json
import re
import shutil
from pathlib import Path
import run
from voice_workbench import prosody_service as service


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--text', required=True)
    parser.add_argument('--words', type=Path, required=True)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',args.name):
        parser.error('Name must be a safe 1–64 character job name.')
    if not 1 <= len(args.text.strip()) <= 200:
        parser.error('Text must contain 1–200 characters.')
    folder = service.JOBS/args.name
    if folder.exists():
        parser.error('This job already exists. Choose a new name.')
    audio = args.audio.resolve(strict=True)
    if audio.suffix.lower() != '.wav':
        parser.error('Import a mono WAV file.')
    words = json.loads(args.words.read_text(encoding='utf-8-sig'))
    if isinstance(words,dict):
        words = words['words']
    normalized = lambda text: ''.join(char.lower() for char in text if char.isalnum())
    if normalized(''.join(word['text'] for word in words)) != normalized(args.text):
        parser.error('Word labels must cover the supplied transcript.')
    # Validate before creating the job or copying audio.
    from sys import path
    path.insert(0,str(Path(__file__).parent/'workers'))
    from analysis import analyze
    analysis = analyze(audio,words)
    (folder/'assets').mkdir(parents=True)
    source = folder/'assets/voice.wav'
    shutil.copyfile(audio,source)
    line = {'id':'line-1', 'text':args.text.strip(), 'draft_text':args.text.strip(), 'speaker':'Speaker',
            'audio_path':str(source), 'source_identity':service.identity(source),
            'duration':analysis['duration'], 'source_duration':analysis['duration'],
            'sample_rate':analysis['sample_rate'], 'words':analysis['words'],
            'pitch_analysis':analysis['pitch_analysis'], 'timing_segments':analysis['timing_segments'],
            'analysis_version':service.VERSION, 'speed':1, 'pitch_semitones':0, 'pitch_curve':[],
            'edits':[], 'timing_edits':[], 'performance_options':{'engine':'System','direction':'Calm','strength':.5}}
    (folder/'request.md').write_text(args.text.strip()+'\n',encoding='utf-8')
    service.atomic_json(folder/'prosody.json', {'schema_version':1,'revision':0,'title':args.name,
                                              'active_line':'line-1','lines':[line]})
    print(folder/'prosody.json')


if __name__ == '__main__':
    main()
