'Revisioned local prosody documents; Praat runs in a configurable CPU Python environment.'
import copy
import json
import math
import os
import subprocess
import threading
import uuid
from datetime import datetime
from pathlib import Path

from . import configuration

ROOT = configuration.ROOT
JOBS = configuration.workspace() / 'jobs'
WORKER = ROOT / 'workers/prosody_core.py'
LOCKS = {}
LOCK_GUARD = threading.Lock()
VERSION = '0.5.0'
ANALYSIS_CACHE = {}
CAPABILITIES = {'backend': 'Praat continuous DurationTier', 'word_splicing': False,
                'silence_insertion': False, 'whole_utterance': True, 'version': VERSION,
                'speed': {'min': 0.75, 'max': 1.25, 'default': 1.0, 'step': 0.01},
                'pitch_semitones': {'min': -3.0, 'max': 3.0, 'default': 0.0, 'step': 0.1},
                'pitch_curve': {'min': -3.0, 'max': 3.0, 'default': [], 'max_points': 64,
                                'min_spacing': 0.02, 'interpolation': 'pchip', 'time_basis': 'source',
                                'total_pitch_min': -3.0, 'total_pitch_max': 3.0}}


class Conflict(ValueError):
    pass


def document_path(value):
    path = Path(value).resolve()
    if path.name != 'prosody.json' or path.parent.parent != JOBS.resolve() or not (path.parent / 'request.md').is_file():
        raise ValueError('Choose a prosody.json document inside a workspace job.')
    return path


def lock_for(path):
    with LOCK_GUARD:
        return LOCKS.setdefault(str(path).lower(), threading.RLock())


def contained_audio(value, job):
    path = Path(value).resolve(strict=True)
    if not path.is_relative_to(job) or path.suffix.lower() != '.wav':
        raise ValueError('Audio must be a WAV file inside the current job.')
    return path


def identity(path):
    stat = Path(path).stat()
    return {'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns}


def atomic_json(path, value):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex[:8] + '.tmp')
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def load(path):
    doc = json.loads(path.read_text(encoding='utf-8-sig'))
    if doc.get('schema_version') != 1 or not doc.get('lines'):
        raise ValueError('Unsupported speech document.')
    for line in doc['lines']:
        line.setdefault('draft_text', line['text'])
        source = contained_audio(line['audio_path'], path.parent)
        if identity(source) != line['source_identity']:
            raise ValueError('The source recording changed. Reimport and analyse it before editing.')
        if line.get('analysis_version') != VERSION:
            key = (str(source), tuple(line['source_identity'].values()),
                   tuple((w['id'], w.get('alignment_start_time', w['start_time']), w.get('alignment_end_time', w['end_time'])) for w in line['words']))
            if key not in ANALYSIS_CACHE:
                ANALYSIS_CACHE[key] = worker(path.parent, {'action': 'analyze', 'source': str(source), 'words': line['words']})
            analysis = ANALYSIS_CACHE[key]
            line['words'] = copy.deepcopy(analysis['words'])
            line['timing_segments'] = copy.deepcopy(analysis['timing_segments'])
            line['pitch_analysis'] = copy.deepcopy(analysis['pitch_analysis'])
            line['analysis_version'] = VERSION
        line.setdefault('tail_target', None)
        line.setdefault('performance_options', {'direction': 'Calm and restrained, asking gently', 'strength': .65, 'engine': 'System'})
        line.setdefault('timing_edits', [])
        line['speed'] = control(line.get('speed', 1.0), 'speed')
        line['pitch_semitones'] = control(line.get('pitch_semitones', 0.0), 'pitch_semitones')
        line['pitch_curve'] = canonical_curve(line.get('pitch_curve', []),
                                               line.get('source_duration', line.get('duration')),
                                               line['pitch_semitones'])
    return doc


def envelope(path, doc):
    return {'document_path': str(path), 'document': doc, 'capabilities': CAPABILITIES}


def get_document(value):
    path = document_path(value)
    with lock_for(path):
        return envelope(path, load(path))


def control(value, name):
    limits = CAPABILITIES[name]
    if isinstance(value, bool):
        raise ValueError('Speed and pitch must be valid numbers.')
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ValueError('Speed and pitch must be valid numbers.') from None
    if not math.isfinite(value) or not limits['min'] <= value <= limits['max']:
        label = 'Speed' if name == 'speed' else 'Pitch'
        raise ValueError(f"{label} is outside the range: {limits['min']}～{limits['max']}。")
    return round(value, 6)


def word_limit(word, speed):
    if not word.get('editable'):
        return 0.0
    capacity = word.get('duration_capacity')
    if capacity is None:
        start, end = word.get('sustain_start'), word.get('sustain_end')
        capacity = (end - start) * 0.75 if start is not None and end is not None else word['max_extra'] / 1.5
    return math.floor(min(0.20, max(0.0, capacity * (2.5 - 1.0 / speed))) * 100 + 1e-8) / 100


def canonical(edits, words, speed=1.0):
    if not isinstance(edits, list):
        raise ValueError('Edits must be a list.')
    known = {w['id']: w for w in words}
    found, result = set(), []
    for edit in edits:
        ident = edit['word_id']
        if ident not in known or ident in found:
            raise ValueError('A word is unknown or duplicated.')
        found.add(ident)
        extra = float(edit['extra_seconds'])
        word = known[ident]
        if not math.isfinite(extra) or extra < 0 or extra > word_limit(word, speed) + 1e-7:
            raise ValueError(f"‘{word.get('text', ident)}\' exceeds the ending-extension limit at this speed. Reduce the extension or increase speed.")
        if extra > 0:
            if not word['editable']:
                raise ValueError('This word has no reliable voiced ending to extend.')
            result.append({'word_id': ident, 'extra_seconds': round(extra, 6)})
    return sorted(result, key=lambda e: e['word_id'])


def canonical_curve(points, duration, pitch=0.0):
    if points is None:
        points = []
    if not isinstance(points, list) or len(points) > 64:
        raise ValueError('A pitch curve must be a list of at most 64 points.')
    result = []
    for point in points:
        if not isinstance(point, dict):
            raise ValueError('Pitch points require source time and a semitone offset.')
        raw_time, raw_delta = point.get('source_time'), point.get('delta_semitones')
        if isinstance(raw_time, bool) or isinstance(raw_delta, bool):
            raise ValueError('Pitch points must contain valid numbers.')
        try:
            time, delta = float(raw_time), float(raw_delta)
        except (ValueError, TypeError):
            raise ValueError('Pitch points must contain valid numbers.') from None
        if not math.isfinite(time) or time < 0 or time > duration:
            raise ValueError('Pitch point time is outside the source recording.')
        if not math.isfinite(delta) or not -3.0 <= delta <= 3.0:
            raise ValueError('Pitch curve offsets must be between -3 and +3 semitones.')
        if not -3.0 <= pitch + delta <= 3.0:
            raise ValueError('Global pitch plus the local curve must stay within -3 to +3 semitones.')
        result.append({'source_time': time, 'delta_semitones': delta})
    result.sort(key=lambda p: p['source_time'])
    if any(b['source_time'] - a['source_time'] < 0.02 - 1e-9 for a, b in zip(result, result[1:])):
        raise ValueError('Adjacent pitch points must be at least 0.02 seconds apart.')
    return result


def canonical_tail(target, line):
    if target is None:
        return None
    try:
        result = {k: float(target[k]) for k in ('start_time','end_time','start_hz','end_hz')}
    except (KeyError, TypeError, ValueError):
        raise ValueError('Invalid voiced-tail target.')
    a,b = result['start_time'], result['end_time']
    if (not all(math.isfinite(v) for v in result.values()) or not .06-1e-8 <= b-a <= .5+1e-8
            or not all(75 <= result[k] <= 600 for k in ('start_hz','end_hz'))
            or not any(a >= r['start_time']-1e-6 and b <= r['end_time']+1e-6 for r in line.get('pitch_analysis',{}).get('regions',[]))):
        raise ValueError('Tail target is outside a reliable voiced region or pitch range.')
    for f in line['pitch_analysis']['frames']:
        if a-1e-6 <= f['time'] <= b+1e-6 and f['reliable']:
            hz = result['start_hz']*(result['end_hz']/result['start_hz'])**((f['time']-a)/(b-a))
            if abs(12*math.log2(hz/f['hz'])) > 6+1e-6:
                raise ValueError('Tail target differs from the source by more than 6 semitones. Reduce the change.')
    return result


def merge(current, proposed, revision):
    if revision != current['revision']:
        raise Conflict('Another editor saved a newer revision. Reload before editing.')
    result = copy.deepcopy(current)
    proposed_lines = proposed.get('lines', [])
    if len(proposed_lines) != len(current['lines']) or {x['id'] for x in proposed_lines} != {x['id'] for x in current['lines']}:
        raise ValueError('Adding or removing lines is not supported in this editor.')
    by_id = {x['id']: x for x in proposed_lines}
    for line in result['lines']:
        incoming = by_id[line['id']]
        from .performance_service import options as performance_options
        line['performance_options'] = performance_options(incoming.get('performance_options', line.get('performance_options')))
        text = incoming.get('draft_text', line.get('draft_text', line['text']))
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 200 or not any(c.isalnum() for c in text):
            raise ValueError('Each line needs 1–200 characters and at least one letter or number.')
        line['draft_text'] = text.strip()
        line['speed'] = control(incoming.get('speed', line.get('speed', 1.0)), 'speed')
        line['pitch_semitones'] = control(incoming.get('pitch_semitones', line.get('pitch_semitones', 0.0)), 'pitch_semitones')
        line['edits'] = canonical(incoming.get('edits', line.get('edits', [])), line['words'], line['speed'])
        line['pitch_curve'] = canonical_curve(incoming.get('pitch_curve', line.get('pitch_curve', [])),
                                              line.get('source_duration', line.get('duration')),
                                              line['pitch_semitones'])
        line['tail_target'] = canonical_tail(incoming.get('tail_target', line.get('tail_target')), line)
        line['timing_edits'] = canonical_timing(incoming.get('timing_edits', line.get('timing_edits', [])), line)
    if proposed.get('active_line') in by_id:
        result['active_line'] = proposed['active_line']
    return result


def canonical_timing(edits, line):
    if not isinstance(edits, list): raise ValueError('Duration edits must be a list.')
    known = {s['id']: s for s in line.get('timing_segments', [])}
    seen, result = set(), []
    base = 1 / line['speed']
    for edit in edits:
        ident, delta = edit['segment_id'], float(edit['delta_seconds'])
        if ident not in known or ident in seen or not math.isfinite(delta):
            raise ValueError('A duration edit is unknown, duplicated or invalid.')
        seen.add(ident); seg = known[ident]
        lo, hi = (.25, 2.) if seg['kind'] == 'pause' else (.65, 1.5)
        capacity = .75 * (seg['end_time'] - seg['start_time'])
        if not capacity*(base*lo-base)-1e-7 <= delta <= capacity*(min(2.5,base*hi)-base)+1e-7:
            raise ValueError('Word or pause duration exceeds the continuous-processing limit at this speed.')
        if delta: result.append({'segment_id': ident, 'delta_seconds': delta})
    return sorted(result, key=lambda x:x['segment_id'])


def worker(job, request):
    tag = 'prosody-' + uuid.uuid4().hex[:12]
    request_path = job / 'logs' / (tag + '.json')
    output_path = job / 'logs' / (tag + '.result.json')
    log_path = job / 'logs' / (tag + '.log')
    request_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(request_path, request)
    with log_path.open('w', encoding='utf-8') as log:
        process = subprocess.run([str(configuration.python()), '-B', '-s', str(WORKER), '--request', str(request_path), '--output', str(output_path)],
                                 stdout=log, stderr=subprocess.STDOUT, timeout=90,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                                 env={**os.environ, 'PYTHONUTF8': '1'})
    result = json.loads(output_path.read_text(encoding='utf-8')) if output_path.exists() else {}
    if process.returncode or 'error' in result:
        raise ValueError(result.get('error', 'Continuous resynthesis failed. See the job logs.'))
    return result


def save_document(value, proposed, revision):
    path = document_path(value)
    with lock_for(path):
        doc = merge(load(path), proposed, revision)
        doc['revision'] += 1
        atomic_json(path, doc)
        return envelope(path, doc)


def render_document(value, line_id, proposed=None, revision=None):
    path = document_path(value)
    with lock_for(path):
        current = load(path)
        doc = merge(current, proposed, revision) if proposed is not None else copy.deepcopy(current)
        line = next((x for x in doc['lines'] if x['id'] == line_id), None)
        if line is None:
            raise ValueError('Choose a line in this document.')
        if line.get('draft_text', line['text']) != line['text']:
            raise ValueError('Text changed. Generate and apply a new recording before previewing edits.')
        speed = control(line.get('speed', 1.0), 'speed')
        pitch = control(line.get('pitch_semitones', 0.0), 'pitch_semitones')
        edits = canonical(line.get('edits', []), line['words'], speed)
        curve = canonical_curve(line.get('pitch_curve', []), line.get('source_duration', line.get('duration')), pitch)
        target = canonical_tail(line.get('tail_target'), line)
        timing = canonical_timing(line.get('timing_edits', []), line)
        render_controls = {'edits': edits, 'speed': speed, 'pitch_semitones': pitch,
                           'pitch_curve': curve, 'timing_edits': timing, 'tail_target': target, 'backend_version': VERSION}
        previous = line.get('last_result')
        if (previous and previous.get('render_controls') == render_controls
                and previous.get('backend', {}).get('version') == VERSION and Path(previous['audio']).is_file()
                and previous.get('output_identity') == identity(previous['audio'])):
            result = previous
        else:
            tag = datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
            output = path.parent / 'outputs/prosody' / tag / (line_id + '.wav')
            result = worker(path.parent, {'action': 'render', 'source': line['audio_path'],
                                          'words': line['words'], 'edits': edits, 'audio_output': str(output),
                                          'speed': speed, 'pitch_semitones': pitch, 'pitch_curve': curve, 'timing_edits': timing, 'tail_target': target})
            if result.get('backend', {}).get('version') != VERSION:
                raise ValueError('Audio worker version mismatch. Update the worker environment.')
            result['edits'] = edits
            result['speed'] = speed
            result['pitch_semitones'] = pitch
            result['pitch_curve'] = curve
            result['tail_target'] = target
            result['timing_edits'] = timing
            result['render_controls'] = render_controls
            result['created_at'] = datetime.now().isoformat(timespec='seconds')
            result['output_identity'] = identity(result['audio'])
            line['last_result'] = result
        doc['active_line'] = line_id
        doc['revision'] += 1
        atomic_json(path, doc)
        return {**envelope(path, doc), 'result': result}


def media_path(value, audio):
    path = document_path(value)
    with lock_for(path):
        doc = load(path)
        allowed = {str(Path(x['audio_path']).resolve()) for x in doc['lines']}
        allowed.update(str(Path(x['last_result']['audio']).resolve()) for x in doc['lines'] if x.get('last_result'))
        resolved = contained_audio(audio, path.parent)
        if str(resolved) not in allowed:
            raise ValueError('Choose audio belonging to this document.')
        return resolved
