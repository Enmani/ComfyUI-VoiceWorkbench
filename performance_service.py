'Queue-backed performance candidates. Adoption is a separate revisioned edit.'
import copy
import json
import os
import secrets
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path
from . import prosody_service as prosody

from . import configuration, generation, host


def options(value):
    value = value or {}
    if not isinstance(value, dict):
        raise ValueError('Invalid performance settings.')
    direction = value.get('direction', 'Calm and restrained, asking gently')
    strength = float(value.get('strength', .65))
    if not isinstance(direction, str) or len(direction) > 300 or not .1 <= strength <= .8:
        raise ValueError('Direction is limited to 300 characters; emotion strength must be 0.1–0.8.')
    engine = value.get('engine', 'System')
    seconds = float(value.get('target_seconds', 0))
    if engine not in ('System','IndexTTS2','AuK') or not 0 <= seconds <= 15:
        raise ValueError('Choose a supported engine. Target duration must be 0 or at most 15 seconds.')
    return {'direction': direction.strip(), 'strength': strength, 'engine':engine, 'target_seconds':seconds}


def candidate_path(value, filename='request.json'):
    path = Path(value).resolve(strict=True)
    if not path.is_file() or len(path.parents) < 4:
        raise ValueError('Choose a performance candidate inside a workspace job.')
    job = path.parents[3]
    if (path.name != filename or path.parent.parent.name != 'performances'
            or path.parent.parent.parent.name != 'outputs'
            or job.parent != prosody.JOBS.resolve() or not (job/'request.md').is_file()):
        raise ValueError('Choose a performance candidate inside a workspace job.')
    return path


def readiness(engine='System'):
    configuration.engine_config(engine)
    entry = next(item for item in configuration.engines() if item['id'] == engine)
    if not entry['available']:
        raise ValueError(f'{engine} is unavailable. See docs/engines.md.')



def prepare(value, line_id, proposed, revision):
    path = prosody.document_path(value)
    with prosody.lock_for(path):
        doc = prosody.merge(prosody.load(path), proposed, revision)
        line = next(x for x in doc['lines'] if x['id'] == line_id)
        setting = options(line.get('performance_options'))
        readiness(setting['engine'])
        if setting['engine'] == 'AuK' and line['draft_text'] != line['text']:
            raise ValueError('AuK edits the existing recording. Generate changed text with System or IndexTTS2 first.')
        folder = path.parent / 'outputs/performances' / (datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(4))
        folder.mkdir(parents=True)
        reference = prosody.contained_audio(line['audio_path'], path.parent)
        baked = setting['engine'] == 'AuK'
        if baked:
            rendered = prosody.worker(path.parent, {'action': 'render', 'source': str(reference),
                'words': line['words'], 'edits': line.get('edits', []), 'audio_output': str(folder/'reference.wav'),
                **{key: line.get(key, default) for key, default in [('speed',1),('pitch_semitones',0),
                   ('pitch_curve',[]),('timing_edits',[]),('tail_target',None)]}})
            seconds = setting['target_seconds'] or rendered['duration']
            if not .15 <= seconds <= 15:
                raise ValueError('AuK takes must be between 0.15 and 15 seconds.')
        else:
            shutil.copyfile(reference, folder/'reference.wav')
            seconds = 0
        req = {'document_path': str(path), 'line_id': line_id, 'text': line['draft_text'],
               'source_audio': line['audio_path'], 'source_identity': line['source_identity'],
               'reference': str(folder/'reference.wav'), 'reference_label': line.get('speaker', 'Current voice'),
               'options': setting, 'seed': secrets.randbelow(2147483647),
               'baked_controls': baked, 'target_seconds': seconds}
        prosody.atomic_json(folder/'submitted-draft.json', doc)
        prosody.atomic_json(folder/'request.json', req)
        prosody.atomic_json(folder/'status.json', {'state':'queued', 'message':'Waiting for the generation queue'})
        return str(folder/'request.json')



def status(value):
    path = candidate_path(value)
    result = json.loads((path.parent/'status.json').read_text(encoding='utf-8'))
    if result['state'] == 'done':
        result['candidate'] = json.loads((path.parent/'candidate.json').read_text(encoding='utf-8'))
        result['candidate_path'] = str(path.parent/'candidate.json')
    return result


def run_process(command, folder, logfile, env, timeout=1800):
    with (folder/logfile).open('w', encoding='utf-8') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   env=env, creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        started = time.monotonic()
        try:
            while process.poll() is None:
                host.check_interrupted()
                if time.monotonic()-started > timeout:
                    raise RuntimeError('Generation timed out. See the candidate logs.')
                time.sleep(.25)
            if process.returncode:
                raise RuntimeError('Generation failed. See '+str(folder/logfile))
        except BaseException:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)
            raise


def execute(value):
    path = candidate_path(value)
    folder = path.parent
    req = json.loads(path.read_text(encoding='utf-8'))
    document = prosody.document_path(req['document_path'])
    if document.parent != path.parents[3]:
        raise ValueError('Candidate and document must belong to the same job.')
    reference = Path(req['reference']).resolve(strict=True)
    if reference != (folder/'reference.wav').resolve():
        raise ValueError('Invalid candidate reference path.')
    settings = options(req['options'])
    if not isinstance(req['text'], str) or not 1 <= len(req['text']) <= 200:
        raise ValueError('Each line must contain 1–200 characters.')
    if (folder/'candidate.json').is_file():
        return str(folder/'candidate.json')
    try:
        readiness(settings['engine'])
        if settings['engine'] != 'System':
            host.release_models()
        generation.generate(path, run_process)
        aligned = json.loads((folder/'aligned.json').read_text(encoding='utf-8'))
        analysis = prosody.worker(document.parent, {'action':'analyze', 'source':str(folder/'voice.wav'), 'words':aligned['words']})
        metadata = json.loads((folder/'generation.json').read_text(encoding='utf-8'))
        candidate = {**req, 'audio':str(folder/'voice.wav'), 'analysis':analysis,
                     'generation':metadata, 'created_at':datetime.now().isoformat(timespec='seconds')}
        if settings['engine'] == 'AuK':
            verification_file = folder/'verification.json'
            verification = json.loads(verification_file.read_text(encoding='utf-8')) if verification_file.exists() else {}
            candidate['verification'] = verification
            candidate['analysis_ready'] = bool(verification.get('text_match'))
            candidate['analysis_note'] = '' if candidate['analysis_ready'] else 'Transcript recognition did not confirm the requested words.'
        prosody.atomic_json(folder/'candidate.json', candidate)
        prosody.atomic_json(folder/'status.json', {'state':'done', 'message':'New take is ready to compare and apply'})
        return str(folder/'candidate.json')
    except BaseException as exc:
        prosody.atomic_json(folder/'status.json', {'state':'error', 'message':str(exc) or 'Task stopped'})
        raise



def adopt(value, proposed, revision, candidate_value, switching=False):
    path = prosody.document_path(value)
    candidate_file = candidate_path(candidate_value, 'candidate.json')
    c = json.loads(candidate_file.read_text(encoding='utf-8'))
    if Path(c['document_path']).resolve() != path or candidate_file.parents[3] != path.parent:
        raise ValueError('Candidate does not belong to this document.')
    with prosody.lock_for(path):
        current = prosody.load(path)
        doc = prosody.merge(current, proposed, revision)
        line = next(x for x in doc['lines'] if x['id']==c['line_id'])
        if (line['draft_text'] != c['text'] or (not switching and
                (line['audio_path'] != c['source_audio'] or line['source_identity'] != c['source_identity']))):
            raise prosody.Conflict('Text or source audio changed. Generate a new take from the current revision.')
        source = prosody.contained_audio(c['audio'], path.parent)
        if source != candidate_file.parent/'voice.wav':
            raise ValueError('Candidate audio path does not match.')
        a = c['analysis']
        if not c.get('analysis_ready', True) or not a:
            raise ValueError('This take is preview-only because text verification or alignment failed.')
        snapshot(path, line, 'Saved before switching')
        # Keep a full old take plus current edits; never attach old phonetic
        # anchors to the new voice. Adoption is the only source mutation.
        archive = candidate_file.parent/('before-adopt-'+str(current['revision'])+'.json')
        prosody.atomic_json(archive, doc)
        line.update(text=c['text'], draft_text=c['text'], audio_path=str(source),
                    source_identity=prosody.identity(source), words=copy.deepcopy(a['words']),
                    duration=a['duration'], source_duration=a['duration'], duration_seconds=a['duration'],
                    sample_rate=a['sample_rate'], timing_segments=copy.deepcopy(a['timing_segments']),
                    pitch_analysis=copy.deepcopy(a['pitch_analysis']), analysis_version=prosody.VERSION,
                    edits=[], timing_edits=[], pitch_curve=[], tail_target=None, last_result=None,
                    performance_options=c['options'], revoice_engine=c.get('generation',{}).get('engine','IndexTTS2'),
                    last_performance=str(candidate_file), alignment_path=str(candidate_file.parent/'aligned.json'))
        if c.get('baked_controls'):
            line.update(speed=1.0, pitch_semitones=0.0)
        doc['revision'] += 1
        prosody.atomic_json(path, doc)
        return prosody.envelope(path, doc)


def media(value):
    path = candidate_path(value, 'candidate.json')
    return path.parent/'voice.wav'


def snapshot(path, line, label):
    folder = path.parent/'outputs/performance-versions'
    folder.mkdir(parents=True, exist_ok=True)
    target = folder/(datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(4)+'.json')
    prosody.atomic_json(target, {'document_path':str(path), 'line_id':line['id'],
        'created_at':datetime.now().isoformat(timespec='seconds'), 'label':label, 'line':copy.deepcopy(line)})
    return target


def read_version(path, line_id, value):
    'Resolve only immutable records belonging to this document and line.'
    record = Path(value).resolve(strict=True)
    if record.parent == path.parent/'outputs/performance-versions' and record.suffix == '.json':
        data = json.loads(record.read_text(encoding='utf-8'))
        if Path(data['document_path']).resolve() == path and data['line_id'] == line_id:
            return 'snapshot', data
    elif record.name == 'candidate.json':
        candidate_path(record, 'candidate.json')
        data = json.loads(record.read_text(encoding='utf-8'))
        if record.parents[3] == path.parent and Path(data['document_path']).resolve() == path and data['line_id'] == line_id:
            return 'candidate', data
    elif (record.parent.parent == path.parent/'outputs/performances'
          and record.name.startswith('before-adopt-') and record.suffix == '.json'):
        # Old full-document archives are exposed as a single-line version only.
        req = json.loads((record.parent/'request.json').read_text(encoding='utf-8'))
        if Path(req['document_path']).resolve() == path and req['line_id'] == line_id:
            doc = json.loads(record.read_text(encoding='utf-8'))
            line = next(x for x in doc['lines'] if x['id'] == line_id)
            return 'snapshot', {'line':line, 'label':'Archived before applying',
                'created_at':datetime.fromtimestamp(record.stat().st_mtime).isoformat(timespec='seconds')}
    raise ValueError('Version does not belong to this line.')


def playable(path, line):
    source = prosody.contained_audio(line['audio_path'], path.parent)
    if prosody.identity(source) != line['source_identity']:
        raise ValueError('The version\'s source recording changed and cannot be restored.')
    controls = {key:line.get(key, default) for key, default in
        [('edits',[]),('timing_edits',[]),('pitch_curve',[]),('tail_target',None),('speed',1.0),('pitch_semitones',0.0)]}
    controls['backend_version'] = prosody.VERSION
    result = line.get('last_result') or {}
    if result.get('render_controls') == controls:
        try:
            audio = prosody.contained_audio(result['audio'], path.parent)
            if result.get('output_identity') == prosody.identity(audio):
                return audio, 'Edited preview'
        except (ValueError, KeyError, FileNotFoundError):
            pass
    return source, 'Original (click Preview to apply edits)'


def versions(value, line_id):
    path = prosody.document_path(value)
    with prosody.lock_for(path):
        doc = prosody.load(path)
        line = next(x for x in doc['lines'] if x['id'] == line_id)
        records = list((path.parent/'outputs/performance-versions').glob('*.json'))
        records += list((path.parent/'outputs/performances').glob('*/candidate.json'))
        records += list((path.parent/'outputs/performances').glob('*/before-adopt-*.json'))
        entries = []
        for record in records:
            try:
                kind, data = read_version(path, line_id, record)
                saved = data.get('line', {})
                audio, playback = playable(path, saved) if kind == 'snapshot' else (prosody.contained_audio(data['audio'], path.parent), 'Generated recording')
                entries.append({'version_path':str(record), 'kind':kind,
                    'label':data.get('label',data.get('generation',{}).get('engine','')+' Performance candidate'), 'created_at':data.get('created_at',record.parent.name),
                    'text':saved.get('draft_text',saved.get('text')) if kind == 'snapshot' else data['text'],
                    'direction':(saved.get('performance_options',{}) if kind == 'snapshot' else data.get('options',{})).get('direction',''),
                    'duration':saved.get('source_duration') if kind == 'snapshot' else data['generation']['duration'],
                    'adoptable':data.get('analysis_ready',True), 'analysis_note':data.get('analysis_note',''),
                    'baked_controls':data.get('baked_controls',False), 'playback':playback})
            except (ValueError, KeyError, FileNotFoundError, StopIteration):
                continue
        entries.sort(key=lambda x:(x['created_at'],x['version_path']), reverse=True)
        return {'versions':entries, 'current_playback':playable(path,line)[1], 'revision':doc['revision']}


def save_version(value, line_id, proposed, revision):
    path = prosody.document_path(value)
    with prosody.lock_for(path):
        doc = prosody.merge(prosody.load(path), proposed, revision)
        line = next(x for x in doc['lines'] if x['id'] == line_id)
        record = snapshot(path, line, 'Saved manually')
        doc['revision'] += 1
        prosody.atomic_json(path, doc)
        return {**prosody.envelope(path,doc), 'version_path':str(record)}


def restore_version(value, line_id, proposed, revision, version_value):
    path = prosody.document_path(value)
    kind, data = read_version(path, line_id, version_value)
    if kind == 'candidate':
        return adopt(value, proposed, revision, version_value, switching=True)
    with prosody.lock_for(path):
        doc = prosody.merge(prosody.load(path), proposed, revision)
        index = next(i for i,x in enumerate(doc['lines']) if x['id'] == line_id)
        restored = copy.deepcopy(data['line'])
        if restored['id'] != line_id:
            raise ValueError('Version line ID does not match.')
        playable(path, restored)
        snapshot(path, doc['lines'][index], 'Saved before restoring')
        doc['lines'][index] = restored
        doc['revision'] += 1
        prosody.atomic_json(path,doc)
        return prosody.envelope(path,doc)


def version_media(value, line_id, version_value):
    path = prosody.document_path(value)
    with prosody.lock_for(path):
        if version_value == 'current':
            return playable(path,next(x for x in prosody.load(path)['lines'] if x['id']==line_id))[0]
        kind, data = read_version(path,line_id,version_value)
        return playable(path,data['line'])[0] if kind == 'snapshot' else prosody.contained_audio(data['audio'],path.parent)
