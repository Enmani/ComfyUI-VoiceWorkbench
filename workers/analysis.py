'Bounded, continuous utterance resynthesis using official Praat DurationTier.\n\nNo word waveform is extracted, stretched independently, or spliced. Pitch is\nanalysed over the complete utterance; global and smooth local shifts scale its\ntier. Local control points are anchored to source time, so they follow duration\nedits. Optional tail_target replaces final Hz within a verified voiced range,\nwith 20 ms eased joins. Duration and pitch are applied\ntogether in one resynthesis, always starting from the original recording.\nWord labels are alignment estimates, not phonetic boundary guarantees.\nRequires praat-parselmouth, NumPy, SciPy and SoundFile.\n'
import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
import parselmouth
import soundfile as sf
from parselmouth.praat import call
from scipy.interpolate import PchipInterpolator


VERSION = '0.5.0'
PITCH_FLOOR = 75.0
PITCH_CEILING = 600.0
FRAME_STEP = .005
MIN_SPAN = .035
MAX_MULTIPLIER = 2.5
MAX_EXTRA = .20
MIN_SPEED = .75
MAX_SPEED = 1.25
MAX_PITCH_SEMITONES = 3.
MAX_PITCH_CURVE_POINTS = 64
MIN_PITCH_POINT_SPACING = .02
BACKEND = {
    'name': 'Praat continuous DurationTier',
    'version': VERSION,
    'praat_version': parselmouth.PRAAT_VERSION,
    'parselmouth_version': parselmouth.__version__,
    'method': 'To Manipulation / Replace duration tier / optional Replace pitch tier / Get resynthesis (overlap-add)',
    'pitch_tier': 'unchanged unless global or local pitch shift requested',
    'pitch_curve': 'source-time PCHIP semitone envelope; linear Hz PitchTier sampled at <=5 ms',
    'word_waveform_splicing': False,
    'silence_padding': False,
    'pitch_floor': PITCH_FLOOR,
    'pitch_ceiling': PITCH_CEILING,
    'reference': 'https://www.fon.hum.uva.nl/praat/manual/TextGrid__To_DurationTier___.html',
}


def _load(source):
    path = Path(source).resolve(strict=True)
    sound = parselmouth.Sound(str(path))
    if sound.n_channels != 1:
        raise ValueError('Only mono recordings are supported. Import a mono WAV.')
    if not .15 <= sound.duration <= 60:
        raise ValueError('Recordings must be between 0.15 and 60 seconds.')
    if not np.all(np.isfinite(sound.values)):
        raise ValueError('Recording contains invalid samples.')
    return path, sound


def _words(words, duration):
    if isinstance(words, dict):
        words = words.get('words', [])
    if not isinstance(words, list) or not words:
        raise ValueError('Word timing annotations are required.')
    result, used, previous = [], set(), 0.
    for i, item in enumerate(words):
        start = float(item.get('alignment_start_time', item['start_time']))
        end = float(item.get('alignment_end_time', item['end_time']))
        word_id = str(item.get('id', 'w%d' % i))
        if (not math.isfinite(start + end) or start < previous - 1e-6
                or start < 0 or end <= start or end > duration + 1e-6):
            raise ValueError('Word timings overlap or exceed the recording. Correct the alignment first.')
        if word_id in used:
            raise ValueError('Duplicate word ID.')
        used.add(word_id)
        previous = end
        result.append({'id': word_id, 'text': str(item.get('text', '')),
                       'start_time': start, 'end_time': end})
    return result


def _quiet_runs(sound):
    'Only sustained very quiet frames; never classify unvoiced speech as silence.'
    x, sr = sound.values[0], int(sound.sampling_frequency)
    n = max(1, round(sr * .005))
    frames = len(x) // n
    blocks = x[:frames * n].reshape(frames, n)
    rms = np.sqrt(np.mean(blocks ** 2, axis=1))
    peaks = np.max(np.abs(blocks), axis=1)
    quiet = (rms < 10 ** (-52 / 20)) & (peaks < 10 ** (-42 / 20))
    return [(a*n/sr, b*n/sr) for a, b in _runs(quiet) if (b-a)*n/sr >= .06]


def _refine_words(sound, words):
    quiet = _quiet_runs(sound)
    for word in words:
        start, end = word['start_time'], word['end_time']
        word.update(alignment_start_time=start, alignment_end_time=end)
        for a, b in quiet:
            # Trim only trailing near-silence reaching the aligner's end.
            if a > start + .04 and a < end - .035 and b >= end - .01:
                word['end_time'] = min(end, a + .0125)
                word['boundary_note'] = 'Trailing near-silence separated; boundaries remain estimates.'
                break
    return words


def timing_segments(sound, words):
    segments = [dict(id='word:' + w['id'], kind='word', word_id=w['id'], text=w['text'],
                     start_time=w['start_time'], end_time=w['end_time']) for w in words]
    # Edit quiet cores only outside spoken word labels; leave guards at both ends.
    for a, b in _quiet_runs(sound):
        for w in words:
            if w['start_time'] <= a < w['end_time']: a = w['end_time']
            if a < w['start_time'] < b: b = w['start_time']
        a, b = a + .015, b - .015
        if b - a >= .04:
            segments.append(dict(id='pause:%d' % round(a*1000000), kind='pause', text='Pause',
                                 start_time=round(a, 6), end_time=round(b, 6)))
    return sorted(segments, key=lambda s: s['start_time'])


def _runs(mask):
    edge = np.diff(np.r_[False, mask, False].astype(np.int8))
    return list(zip(np.flatnonzero(edge == 1), np.flatnonzero(edge == -1)))


def _global_controls(speed, pitch_semitones):
    if isinstance(speed, bool) or isinstance(pitch_semitones, bool):
        raise ValueError('Speed and pitch must be numbers.')
    try:
        speed, pitch_semitones = float(speed), float(pitch_semitones)
    except (TypeError, ValueError):
        raise ValueError('Speed and pitch must be numbers.') from None
    if not math.isfinite(speed) or not MIN_SPEED <= speed <= MAX_SPEED:
        raise ValueError('Speed must be between 0.75 and 1.25 times.')
    if (not math.isfinite(pitch_semitones)
            or not -MAX_PITCH_SEMITONES <= pitch_semitones <= MAX_PITCH_SEMITONES):
        raise ValueError('Global pitch must be between -3 and +3 semitones.')
    return speed, pitch_semitones


def _maximum_extra(duration_capacity, speed):
    available = min(MAX_EXTRA, duration_capacity * (MAX_MULTIPLIER - 1. / speed))
    return max(0., math.floor((available + 1e-9) * 100) / 100)


def _pitch_controls(points, duration, global_shift=0.):
    'Validate and sort source-time anchors without clamping user values.'
    if points is None:
        return []
    if not isinstance(points, list) or len(points) > MAX_PITCH_CURVE_POINTS:
        raise ValueError('Pitch curve must contain at most 64 points.')
    result = []
    for point in points:
        if not isinstance(point, dict):
            raise ValueError('Pitch points require source time and a semitone offset.')
        try:
            raw_time, raw_delta = point['source_time'], point['delta_semitones']
            if isinstance(raw_time, bool) or isinstance(raw_delta, bool):
                raise ValueError()
            time, delta = float(raw_time), float(raw_delta)
        except (KeyError, TypeError, ValueError):
            raise ValueError('Pitch points require valid source time and a semitone offset.') from None
        if not math.isfinite(time) or not 0. <= time <= duration:
            raise ValueError('Pitch point time is outside the recording.')
        if not math.isfinite(delta) or not -MAX_PITCH_SEMITONES <= delta <= MAX_PITCH_SEMITONES:
            raise ValueError('Local pitch must be between -3 and +3 semitones.')
        if not -MAX_PITCH_SEMITONES <= global_shift + delta <= MAX_PITCH_SEMITONES:
            raise ValueError('Global pitch plus the curve must stay within -3 to +3 semitones.')
        result.append({'source_time': time, 'delta_semitones': delta})
    result.sort(key=lambda point: point['source_time'])
    if any(right['source_time'] - left['source_time'] < MIN_PITCH_POINT_SPACING - 1e-9
           for left, right in zip(result, result[1:])):
        raise ValueError('Adjacent pitch points must be at least 0.02 seconds apart.')
    return result


def _pitch_envelope(points, times):
    "PCHIP preserves each interval's bounds; outside anchors stay constant."
    times = np.asarray(times, dtype=float)
    if not points:
        return np.zeros_like(times)
    values = np.array([point['delta_semitones'] for point in points])
    if len(points) == 1:
        return np.full_like(times, values[0])
    anchors = np.array([point['source_time'] for point in points])
    interpolated = PchipInterpolator(anchors, values, extrapolate=False)(
        np.clip(times, anchors[0], anchors[-1]))
    return np.where(times <= anchors[0], values[0],
                    np.where(times >= anchors[-1], values[-1], interpolated))


def pitch_analysis(sound):
    'Measured AC F0 only; gaps are never interpolated into reliable speech.'
    pitch = sound.to_pitch_ac(time_step=FRAME_STEP, pitch_floor=PITCH_FLOOR, pitch_ceiling=PITCH_CEILING)
    frames, runs, start, previous = [], [], None, None
    for t, candidate in zip(pitch.xs(), pitch.selected_array):
        hz, strength = float(candidate['frequency']), float(candidate['strength'])
        reliable = hz > 0 and strength >= .75
        if reliable and previous and abs(math.log2(hz / previous)) > .20:
            reliable = False
        frames.append({'time': round(float(t), 6), 'hz': round(hz, 3) if hz else None, 'reliable': bool(reliable)})
        if reliable and start is None:
            start = float(t)
        if not reliable and start is not None:
            if float(t) - FRAME_STEP - start >= .06 - 1e-8:
                runs.append({'start_time': round(start, 6), 'end_time': round(float(t)-FRAME_STEP, 6)})
            start = None
        previous = hz if reliable else None
    if start is not None and float(pitch.xs()[-1])-start >= .06-1e-8:
        runs.append({'start_time': round(start, 6), 'end_time': round(float(pitch.xs()[-1]), 6)})
    return {'frames': frames, 'regions': runs, 'method': 'Praat AC, strength >= 0.75; conservative estimate'}


def validate_tail(target, analysis):
    if target is None:
        return None
    try:
        result = {k: float(target[k]) for k in ('start_time', 'end_time', 'start_hz', 'end_hz')}
    except (KeyError, TypeError, ValueError):
        raise ValueError('Tail target requires start/end times and frequencies.')
    a,b = result['start_time'], result['end_time']
    if (not all(math.isfinite(v) for v in result.values()) or not .06-1e-8 <= b-a <= .5+1e-8
            or not all(75 <= result[k] <= 600 for k in ('start_hz','end_hz'))
            or not any(a >= r['start_time']-1e-6 and b <= r['end_time']+1e-6 for r in analysis['regions'])):
        raise ValueError('Choose 0.06–0.5 seconds within one reliable voiced region; target pitch must be 75–600 Hz.')
    for frame in analysis['frames']:
        if a-1e-6 <= frame['time'] <= b+1e-6 and frame['reliable']:
            fraction = (frame['time']-a)/(b-a)
            hz = result['start_hz'] * (result['end_hz']/result['start_hz']) ** fraction
            if abs(12*math.log2(hz/frame['hz'])) > 6+1e-6:
                raise ValueError('Target differs from the source by more than 6 semitones. Reduce the change.')
    return result


def tail_frequencies(times, frequencies, target):
    if target is None:
        return frequencies
    a,b = target['start_time'], target['end_time']
    fraction = np.clip((times-a)/(b-a), 0, 1)
    desired = target['start_hz'] * (target['end_hz']/target['start_hz']) ** fraction
    # 20 ms eased transitions stay within the verified voiced range.
    ramp = min(.02, (b-a)/4)
    weight = np.clip(np.minimum((times-a)/ramp, (b-times)/ramp), 0, 1)
    weight = weight*weight*(3-2*weight)
    return np.exp(np.log(frequencies)*(1-weight)+np.log(desired)*weight)


def _analyse_sound(sound, words, speed=1.):
    words = _refine_words(sound, _words(words, sound.duration))
    pitch = sound.to_pitch_ac(time_step=FRAME_STEP, pitch_floor=PITCH_FLOOR,
                              pitch_ceiling=PITCH_CEILING)
    times = pitch.xs()
    frequencies = pitch.selected_array['frequency']
    strengths = pitch.selected_array['strength']
    samples = sound.values[0]
    sr = sound.sampling_frequency
    energies = np.array([np.sqrt(np.mean(samples[max(0, int((t - .005) * sr)):
                                       min(len(samples), int((t + .005) * sr))] ** 2))
                         for t in times])
    floor = max(float(np.percentile(energies, 90)) * .035, 10 ** (-55 / 20))
    credible = (frequencies > 0) & (strengths >= .75) & (energies >= floor)
    for word in words:
        start, end = word['start_time'], word['end_time']
        selected = credible & (times >= start) & (times <= end)
        # A duration bump must fit entirely inside a contiguous voiced run.
        # Prefer the last credible run to express a held ending, not its onset.
        candidates = []
        for left, right in _runs(selected):
            a = max(start, float(times[left] - FRAME_STEP / 2))
            b = min(end, float(times[right - 1] + FRAME_STEP / 2))
            if b - a < MIN_SPAN:
                continue
            # A short voiced onset with a long unvoiced remainder is not a
            # credible held ending; it can be the previous syllable when
            # forced-alignment boundaries are inaccurate.
            if end - b > min(.025, (end - start) * .25) + 1e-8:
                continue
            f = frequencies[left:right]
            if np.any(np.abs(np.diff(np.log2(f))) > .20):
                continue
            candidates.append((a, b, float(np.median(strengths[left:right]))))
        if not candidates:
            word.update(editable=False, sustain_start=None, sustain_end=None,
                        max_extra=0., duration_capacity=0.,
                        reason='No sufficiently stable voiced ending is available to extend.')
            continue
        a, b, strength = candidates[-1]
        # Four points give the official trapezoid: 1, peak, peak, 1.
        # Generous 25% transitions avoid abrupt changes in time scale.
        a, b = round(a, 6), round(b, 6)
        capacity = (b - a) * .75
        maximum = _maximum_extra(capacity, speed)
        if maximum < .02:
            word.update(editable=False, sustain_start=None, sustain_end=None,
                        max_extra=0., duration_capacity=0.,
                        reason='The stable voiced ending is too short to extend.')
            continue
        word.update(editable=True, sustain_start=a,
                    sustain_end=b, max_extra=maximum,
                    duration_capacity=capacity,
                    pitch_strength=round(strength, 4),
                    default_extra=min(.06, maximum),
                    reason='Small continuous extension. Word boundaries are estimates; listen to the preview.')
    return words


def analyze(source, words):
    path, sound = _load(source)
    words = _analyse_sound(sound, words)
    return {'source': str(path), 'duration': sound.duration,
            'sample_rate': int(sound.sampling_frequency),
            'pitch_analysis': pitch_analysis(sound),
            'words': words, 'timing_segments': timing_segments(sound, words), 'backend': dict(BACKEND),
            'alignment_is_estimated': True}
