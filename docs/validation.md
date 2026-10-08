# Validation

Executed on Windows, 2026-10-08.

- Python 3.10.11, Parselmouth 0.4.7, NumPy 2.2.6, SciPy 1.15.3, SoundFile 0.14.0.
- Eight real audio/persistence tests pass: unchanged WAV preservation; measured pitch shift plus speed in one pass; word/pause duration; invalid curves and source overwrite rejection; revision conflict; complete version restoration; workspace containment; system-speech candidate generation and explicit adoption.
- Node.js source checks pass, including bounded PCHIP behavior and duration-coordinate integration/inversion. No source file exceeds 500 lines.
- IndexTTS2 generated the bundled English sentence on an RTX 3090, using only the synthetic SAPI reference. The generated take is 4.923 seconds at 22.05 kHz. Qwen3 forced alignment ran in English on CPU and produced non-overlapping word spans. The curve preview uses one continuous Praat resynthesis.
- An isolated CPU ComfyUI instance registered both public nodes and routes, and executed `VWVoiceEditor` through its real queue successfully.
- The standalone browser completed pitch-point keyboard editing, ending extension, real preview, version save, queued system-speech generation, explicit candidate application and restoration of the saved curve/audio version.
- Mouse dragging changed the selected pitch point and marked its preview stale. At 720 px and 320 px, page width remained within the viewport; the sentence timeline scrolls independently.
- Independent English SenseVoice recognition matched the bundled AI recording's transcript, ignoring punctuation and letter case.

The standalone UI is verified independently of the user's active workspace. Linux/macOS system speech, optional AuK English editing and arbitrary third-party model installations remain untested locally. GitHub Actions provides CPU regression coverage on Windows and Linux; its results are separate from local checks.

Audio naturalness requires listening. A successful alignment verifies usable word coordinates, not recognition accuracy.
