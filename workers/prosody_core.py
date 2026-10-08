"""Isolated CPU command line entry point."""
import argparse
import json
from pathlib import Path
from analysis import analyze
from resynthesis import render

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, help='UTF-8 JSON request file')
    parser.add_argument('--output', required=True, help='UTF-8 JSON result file')
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8-sig'))
    try:
        if request.get('action') == 'analyze':
            result = analyze(request['source'], request['words'])
        elif request.get('action') == 'render':
            result = render(request['source'], request['words'],
                            request.get('edits', []), request.get('audio_output') or request['output'],
                            speed=request.get('speed', 1.),
                            pitch_semitones=request.get('pitch_semitones', 0.),
                            pitch_curve=request.get('pitch_curve'), timing_edits=request.get('timing_edits', []), tail_target=request.get('tail_target'))
        else:
            raise ValueError('Unknown operation.')
    except Exception as error:
        Path(args.output).write_text(json.dumps({'error': str(error)}, ensure_ascii=False),
                                     encoding='utf-8')
        raise
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2),
                                 encoding='utf-8')


if __name__ == '__main__':
    main()
