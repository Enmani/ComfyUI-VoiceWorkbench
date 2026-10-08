"""Real audio and persistence regressions; no mocked resynthesis."""
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
os.environ['VOICE_WORKBENCH_STANDALONE'] = '1'
spec = importlib.util.spec_from_file_location('voice_workbench', ROOT/'__init__.py',
                                            submodule_search_locations=[str(ROOT)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
from voice_workbench import performance_service as performance, prosody_service as service, samples, configuration
sys.path.insert(0, str(ROOT/'workers'))
from analysis import analyze
from resynthesis import render


class AudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.source = ROOT/'examples/first-light/voice.wav'
        cls.example = json.loads((cls.source.parent/'example.json').read_text(encoding='utf-8'))
        cls.analysis = analyze(cls.source, cls.example['words'])
        cls.original_bytes = cls.source.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def output(self, name):
        return Path(self.temp.name)/(name+'.wav')

    def test_no_edit_preserves_audio(self):
        result = render(self.source, self.analysis['words'], [], self.output('unchanged'))
        self.assertEqual(self.original_bytes, Path(result['audio']).read_bytes())
        self.assertEqual(result['diagnostics']['whole_utterance_resyntheses'], 0)

    def test_pitch_and_speed_in_one_pass(self):
        result = render(self.source, self.analysis['words'], [], self.output('shift'),
                        speed=.9, pitch_curve=[{'source_time':0,'delta_semitones':2}])
        self.assertEqual(result['diagnostics']['whole_utterance_resyntheses'], 1)
        self.assertAlmostEqual(result['duration'], self.analysis['duration']/.9, delta=.025)
        reliable = lambda frames: {round(f['time'],3):f['hz'] for f in frames if f['reliable']}
        original = reliable(self.analysis['pitch_analysis']['frames'])
        shifted = reliable(result['pitch_analysis']['frames'])
        ratios = [12*np.log2(shifted[round(t/.9,3)]/hz) for t,hz in original.items()
                  if round(t/.9,3) in shifted]
        self.assertGreater(len(ratios), 10)
        self.assertAlmostEqual(float(np.median(ratios)), 2, delta=.3)
        self.assertEqual(self.original_bytes, self.source.read_bytes())

    def test_word_and_pause_duration(self):
        word = next(s for s in self.analysis['timing_segments'] if s['kind']=='word' and s['end_time']-s['start_time']>.2)
        pause = next(s for s in self.analysis['timing_segments'] if s['kind']=='pause' and s['end_time']-s['start_time']>.2)
        result = render(self.source, self.analysis['words'], [], self.output('duration'),
                        timing_edits=[{'segment_id':word['id'],'delta_seconds':.025},
                                      {'segment_id':pause['id'],'delta_seconds':-.05}])
        self.assertAlmostEqual(result['duration'], self.analysis['duration']-.025, delta=.025)
        self.assertEqual(result['diagnostics']['whole_utterance_resyntheses'], 1)

    def test_reject_invalid_curve_and_source_overwrite(self):
        for points in ([{'source_time':0,'delta_semitones':4}],
                       [{'source_time':0,'delta_semitones':0},{'source_time':.01,'delta_semitones':1}],
                       [{'source_time':float('nan'),'delta_semitones':0}]):
            with self.subTest(points=points), self.assertRaises(ValueError):
                render(self.source,self.analysis['words'],[],self.output('invalid'),pitch_curve=points)
        with self.assertRaises(ValueError):
            render(self.source,self.analysis['words'],[],self.source)


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = service.JOBS
        service.JOBS = Path(self.temp.name)/'jobs'
        self.data = samples.default_document()
        self.path = self.data['document_path']

    def tearDown(self):
        service.JOBS = self.previous
        self.temp.cleanup()

    def test_revision_conflict_keeps_saved_edits(self):
        doc = copy.deepcopy(self.data['document'])
        doc['lines'][0]['speed'] = .95
        saved = service.save_document(self.path, doc, doc['revision'])
        with self.assertRaises(service.Conflict):
            service.save_document(self.path, doc, doc['revision'])
        self.assertEqual(service.get_document(self.path)['document']['lines'][0]['speed'], .95)
        self.assertEqual(saved['document']['revision'], 1)

    def test_versions_restore_recording_and_controls(self):
        saved = performance.save_version(self.path,'line-1',self.data['document'],0)
        changed = copy.deepcopy(saved['document'])
        changed['lines'][0]['speed'] = .9
        changed = service.save_document(self.path,changed,1)
        restored = performance.restore_version(self.path,'line-1',changed['document'],2,saved['version_path'])
        self.assertEqual(restored['document']['lines'][0]['speed'],1)
        self.assertEqual(len(performance.versions(self.path,'line-1')['versions']),2)

    def test_paths_cannot_escape_workspace(self):
        with self.assertRaises(ValueError):
            service.document_path(ROOT/'prosody.json')
        with self.assertRaises(ValueError):
            service.contained_audio(ROOT/'examples/first-light/voice.wav',Path(self.path).parent)

    @unittest.skipUnless(configuration.windows_speech_available(),'Requires an installed English Windows speech voice')
    def test_generation_is_candidate_until_applied(self):
        doc = copy.deepcopy(self.data['document'])
        doc['lines'][0]['draft_text'] = 'Hello there. Let the story begin.'
        original = doc['lines'][0]['audio_path']
        request = performance.prepare(self.path,'line-1',doc,0)
        candidate = performance.execute(request)
        self.assertEqual(service.get_document(self.path)['document']['lines'][0]['audio_path'], original)
        data = json.loads(Path(candidate).read_text(encoding='utf-8'))
        self.assertGreater(data['analysis']['duration'], .15)
        applied = performance.adopt(self.path,doc,0,candidate)
        line = applied['document']['lines'][0]
        self.assertEqual(line['text'],doc['lines'][0]['draft_text'])
        self.assertEqual(line['pitch_curve'],[])
        self.assertNotEqual(line['audio_path'],original)
        self.assertEqual(len(performance.versions(self.path,'line-1')['versions']),3)


if __name__ == '__main__':
    unittest.main()
