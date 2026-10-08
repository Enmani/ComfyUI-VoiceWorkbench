"""Copy the bundled example into a mutable, isolated workspace job."""
import copy
import json
import shutil
from . import configuration
from . import prosody_service as service


def default_document():
    folder = service.JOBS/'first-light'
    path = folder/'prosody.json'
    with service.lock_for(path):
        if path.is_file():
            return service.get_document(str(path))
        example = configuration.ROOT/'examples/first-light'
        metadata = json.loads((example/'example.json').read_text(encoding='utf-8'))
        folder.mkdir(parents=True, exist_ok=True)
        source = folder/'assets/voice.wav'
        source.parent.mkdir(exist_ok=True)
        shutil.copyfile(example/'voice.wav', source)
        analysis = service.worker(folder, {'action':'analyze', 'source':str(source), 'words':metadata['words']})
        line = {'id':'line-1', 'speaker':'Narrator', 'text':metadata['text'], 'draft_text':metadata['text'],
                'audio_path':str(source), 'source_identity':service.identity(source),
                'duration':analysis['duration'], 'source_duration':analysis['duration'],
                'sample_rate':analysis['sample_rate'], 'words':analysis['words'],
                'pitch_analysis':analysis['pitch_analysis'], 'timing_segments':analysis['timing_segments'],
                'analysis_version':service.VERSION, 'speed':1.0, 'pitch_semitones':0.0,
                'pitch_curve':metadata['pitch_curve'], 'edits':[], 'timing_edits':[], 'tail_target':None,
                'performance_options':{'engine':'System', 'direction':'Calm and curious', 'strength':.5, 'target_seconds':0}}
        doc = {'schema_version':1, 'revision':0, 'title':'First Light · Default example',
               'active_line':'line-1', 'lines':[line]}
        (folder/'request.md').write_text('# First Light\n\n' + metadata['text'] + '\n', encoding='utf-8')
        service.atomic_json(path, doc)
        return service.envelope(path, doc)
