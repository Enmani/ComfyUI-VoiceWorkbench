"""Apply duration and pitch together in a single continuous resynthesis."""
import math
import shutil
from pathlib import Path
import numpy as np
import soundfile as sf
from parselmouth.praat import call
from analysis import (BACKEND, FRAME_STEP, PITCH_FLOOR, PITCH_CEILING,
    MAX_MULTIPLIER, MAX_PITCH_SEMITONES, _load, _global_controls, _pitch_controls, _pitch_envelope,
    _analyse_sound, timing_segments, pitch_analysis, validate_tail, tail_frequencies)

def _apply_pitch_curve(manipulation, sound, points, global_shift, tail_target=None):
    'Replace one PitchTier; never resynthesize or split audio here.\n\n    Praat interpolates the original tier linearly in Hz. Preserve those values\n    while densely sampling our PCHIP semitone envelope, then let Praat handle\n    pitch and duration together in the existing utterance resynthesis.\n    '
    original = call(manipulation, 'Extract pitch tier')
    count = int(call(original, 'Get number of points'))
    if not count:
        return {'original_pitch_points': 0, 'replacement_pitch_points': 0,
                'pitch_tier_max_step_seconds': None,
                'pitch_curve_voiced_signal': False}
    original_times = np.array([call(original, 'Get time from index', i)
                               for i in range(1, count + 1)])
    original_frequencies = np.array([call(original, 'Get value at index', i)
                                     for i in range(1, count + 1)])
    regular = np.linspace(sound.xmin, sound.xmax,
                          int(math.ceil(sound.duration / FRAME_STEP)) + 1)
    times = np.unique(np.r_[regular, original_times,
                             [point['source_time'] for point in points]])
    offsets = global_shift + _pitch_envelope(points, times)
    frequencies = np.interp(times, original_times, original_frequencies)
    frequencies *= 2. ** (offsets / 12.)
    if (not np.all(np.isfinite(frequencies)) or np.any(frequencies <= 0)
            or np.max(np.abs(offsets)) > MAX_PITCH_SEMITONES + 1e-9):
        raise ValueError('Pitch curve produced invalid frequencies. Processing stopped.')
    frequencies = tail_frequencies(times, frequencies, tail_target)
    replacement = call('Create PitchTier', 'continuous_pitch', sound.xmin, sound.xmax)
    for time, frequency in zip(times, frequencies):
        call(replacement, 'Add point', float(time), float(frequency))
    call([replacement, manipulation], 'Replace pitch tier')
    return {'original_pitch_points': count, 'replacement_pitch_points': len(times),
            'pitch_tier_max_step_seconds': float(np.max(np.diff(times))),
            'total_pitch_offset_min_semitones': float(np.min(offsets)),
            'total_pitch_offset_max_semitones': float(np.max(offsets)),
            'pitch_curve_voiced_signal': True}


def _curve(words, edits, duration, speed=1., segments=None, timing_edits=None):
    baseline = 1. / speed
    by_id = {word['id']: word for word in words}
    used, bumps, approved = set(), [], []
    for edit in edits:
        word_id = str(edit['word_id'])
        if word_id not in by_id or word_id in used:
            raise ValueError('Edited word is unknown or duplicated.')
        used.add(word_id)
        extra = float(edit['extra_seconds'])
        if not math.isfinite(extra) or extra < 0:
            raise ValueError('Ending extension must be a nonnegative number.')
        if extra == 0:
            continue
        word = by_id[word_id]
        if not word.get('editable') or extra > word['max_extra'] + 1e-7:
            raise ValueError('\'%s\' can be extended by at most %.2f seconds.' %
                             (word['text'], word['max_extra']))
        a, b = word['sustain_start'], word['sustain_end']
        transition = (b - a) * .25
        peak = baseline + extra / ((b - a) - transition)
        if peak > MAX_MULTIPLIER + 1e-5:
            raise ValueError('Ending duration multiplier exceeds the limit.')
        bumps.append([(a, baseline), (a + transition, peak),
                      (b - transition, peak), (b, baseline)])
        approved.append({'word_id': word_id, 'text': word['text'],
                         'extra_seconds': extra, 'sustain_start': a,
                         'sustain_end': b, 'peak_multiplier': peak})
    bumps.sort(key=lambda b: b[0][0])
    for left, right in zip(bumps, bumps[1:]):
        if right[0][0] < left[-1][0] - 1e-9:
            raise ValueError('Ending regions overlap. Correct the alignment first.')
    known = {s['id']: s for s in (segments or [])}
    seen = set()
    for edit in timing_edits or []:
        ident, delta = edit['segment_id'], float(edit['delta_seconds'])
        if ident not in known or ident in seen or not math.isfinite(delta):
            raise ValueError('Invalid word or pause duration edit.')
        seen.add(ident); s = known[ident]; a,b=s['start_time'],s['end_time']
        lo, hi = ((.25, 2.) if s['kind']=='pause' else (.65, 1.5))
        peak = baseline + delta / (.75*(b-a))
        if peak < baseline*lo-1e-7 or peak > min(2.5,baseline*hi)+1e-7:
            raise ValueError('Word or pause duration exceeds the continuous-processing limit.')
        if delta:
            bumps.append([(a,baseline),(a+(b-a)*.25,peak),(b-(b-a)*.25,peak),(b,baseline)])
    knots = sorted({0., duration, *(t for bump in bumps for t,v in bump)})
    points = [(t, baseline + sum(float(np.interp(t,[p[0] for p in bump],[p[1]-baseline for p in bump],left=0,right=0)) for bump in bumps)) for t in knots]
    if any(v < .15 or v > 2.5+1e-7 for t,v in points):
        raise ValueError('Combined word and ending edits exceed the limit. Reduce one adjustment.')
    return points, approved


def _mapped_time(t, points):
    'Integral of the piecewise linear duration curve; no audio processing.'
    result = 0.
    for (a, av), (b, bv) in zip(points, points[1:]):
        if t <= a:
            break
        length = min(t, b) - a
        result += av * length + .5 * (bv - av) * length * length / (b - a)
        if t <= b:
            break
    return result


def render(source, analyzed_words, edits, output, speed=1., pitch_semitones=0.,
           pitch_curve=None, timing_edits=None, tail_target=None):
    speed, pitch_semitones = _global_controls(speed, pitch_semitones)
    source_path, sound = _load(source)
    pitch_curve = _pitch_controls(pitch_curve, sound.duration, pitch_semitones)
    tail_target = validate_tail(tail_target, pitch_analysis(sound))
    local_pitch_change = any(point['delta_semitones'] != 0. for point in pitch_curve)
    output_path = Path(output).resolve()
    if output_path == source_path:
        raise ValueError('Derived audio cannot overwrite the original.')
    if output_path.suffix.lower() != '.wav':
        raise ValueError('Output must be a WAV file.')
    # Recompute acoustic eligibility rather than trusting client-provided limits.
    words = _analyse_sound(sound, analyzed_words, speed)
    segments = timing_segments(sound, words)
    curve, approved = _curve(words, edits, sound.duration, speed, segments, timing_edits)
    requested = sum(edit['extra_seconds'] for edit in approved)
    global_duration_delta = sound.duration / speed - sound.duration
    target_duration = _mapped_time(sound.duration, curve)
    no_edit = not approved and not any(e['delta_seconds'] for e in (timing_edits or [])) and speed == 1. and pitch_semitones == 0. and not local_pitch_change and tail_target is None
    pitch_diagnostics = {}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if no_edit:
        if source_path.suffix.lower() == '.wav':
            shutil.copyfile(str(source_path), str(output_path))
        else:
            sf.write(str(output_path), sound.values.T,
                     int(sound.sampling_frequency), subtype='PCM_24')
        result_sound = sound
        resyntheses = 0
    else:
        manipulation = call(sound, 'To Manipulation', FRAME_STEP,
                            PITCH_FLOOR, PITCH_CEILING)
        duration_tier = call('Create DurationTier', 'continuous_duration',
                             sound.xmin, sound.xmax)
        for t, multiplier in curve:
            call(duration_tier, 'Add point', t, multiplier)
        call([duration_tier, manipulation], 'Replace duration tier')
        if local_pitch_change or tail_target:
            pitch_diagnostics = _apply_pitch_curve(manipulation, sound, pitch_curve,
                                                    pitch_semitones, tail_target)
        elif pitch_semitones != 0.:
            pitch_tier = call(manipulation, 'Extract pitch tier')
            call(pitch_tier, 'Multiply frequencies', sound.xmin, sound.xmax,
                 2. ** (pitch_semitones / 12.))
            call([pitch_tier, manipulation], 'Replace pitch tier')
        result_sound = call(manipulation, 'Get resynthesis (overlap-add)')
        resyntheses = 1
        if not np.all(np.isfinite(result_sound.values)):
            raise ValueError('Resynthesis produced invalid samples. Export stopped.')
        if float(np.max(np.abs(result_sound.values))) >= 1.:
            raise ValueError('Resynthesis exceeded the amplitude limit. Export stopped.')
        sf.write(str(output_path), result_sound.values.T,
                 int(result_sound.sampling_frequency), subtype='PCM_24')
    info = sf.info(str(output_path))
    duration = info.frames / info.samplerate
    mapped = []
    for word in words:
        mapped.append(dict(word, source_start_time=word['start_time'],
                           source_end_time=word['end_time'],
                           start_time=_mapped_time(word['start_time'], curve),
                           end_time=_mapped_time(word['end_time'], curve)))
    backend = dict(BACKEND, pitch_tier=(
        'absolute voiced-tail Hz target with eased joins over global/local pitch' if tail_target else
        'scaled by PCHIP local + global semitone envelope on source-time anchors'
        if local_pitch_change or tail_target else 'unchanged' if pitch_semitones == 0.
        else 'scaled by 2**(pitch_semitones/12), relative contour preserved'))
    return {'audio': str(output_path), 'source': str(source_path),
            'duration': duration, 'sample_rate': info.samplerate,
            'actual_duration': duration, 'target_duration': target_duration,
            'speed': speed, 'pitch_semitones': pitch_semitones,
            'tail_target': tail_target, 'pitch_analysis': pitch_analysis(result_sound),
            'pitch_curve': pitch_curve,
            'mapped_pitch_curve': [dict(point, time=_mapped_time(point['source_time'], curve))
                                   for point in pitch_curve],
            'words': mapped, 'edits': approved, 'requested_extra': requested,
            'timing_edits': timing_edits or [],
            'timing_segments': [dict(s, start_time=_mapped_time(s['start_time'],curve), end_time=_mapped_time(s['end_time'],curve)) for s in segments],
            'actual_extra': duration - sound.duration,
            'global_duration_delta': global_duration_delta,
            'timing_duration_delta': sum(e['delta_seconds'] for e in (timing_edits or [])),
            'actual_tail_extra': duration - sound.duration / speed - sum(e['delta_seconds'] for e in (timing_edits or [])),
            'backend': backend,
            'curve': [{'time': t, 'multiplier': v} for t, v in curve],
            'diagnostics': {'source_duration': sound.duration,
                            'tail_target_active': tail_target is not None,
                            'tail_target_join_seconds': .02 if tail_target else None,
                            'pitch_curve_point_count': len(pitch_curve),
                            'pitch_curve_active': local_pitch_change,
                            'pitch_curve_interpolation': 'PCHIP in semitones; constant endpoint extension',
                            'pitch_curve_anchor': 'source time; mapped through the same DurationTier',
                            **pitch_diagnostics,
                            'curve_target_duration': _mapped_time(sound.duration, curve),
                            'duration_error_seconds': duration - target_duration,
                            'whole_utterance_resyntheses': resyntheses,
                            'source_peak': float(np.max(np.abs(sound.values))),
                            'output_peak': float(np.max(np.abs(result_sound.values))),
                            'word_times': 'curve-mapped alignment estimates; not realigned',
                            'no_edit_preserves_wav_bytes': no_edit and source_path.suffix.lower() == '.wav',
                            'naturalness': 'requires listener assessment'}}
