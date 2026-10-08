param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
public class WordMark {
    public string text;
    public double start_time;
    public int character_position;
}
public class SystemVoice {
    public static WordMark[] Render(string text, string output, string voice) {
        var marks = new List<WordMark>();
        using (var speech = new SpeechSynthesizer()) {
            if (!String.IsNullOrEmpty(voice)) speech.SelectVoice(voice);
            else {
                bool found = false;
                foreach (var installed in speech.GetInstalledVoices()) {
                    if (installed.Enabled && installed.VoiceInfo.Culture.TwoLetterISOLanguageName == "en") {
                        speech.SelectVoice(installed.VoiceInfo.Name); found = true; break;
                    }
                }
                if (!found) throw new Exception("Install an English Windows speech voice.");
            }
            speech.SpeakProgress += (sender, e) => marks.Add(new WordMark {
                text = e.Text, start_time = e.AudioPosition.TotalSeconds,
                character_position = e.CharacterPosition
            });
            // System.Speech reports positions using its 16 kHz PCM time base.
            speech.SetOutputToWaveFile(output, new SpeechAudioFormatInfo(16000,
                AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            speech.Speak(text);
        }
        return marks.ToArray();
    }
}
'@
$req = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
$folder = Split-Path -Parent $Request
$voice = ''
if ($env:VOICE_WORKBENCH_ENGINE_CONFIG) {
    $config = $env:VOICE_WORKBENCH_ENGINE_CONFIG | ConvertFrom-Json
    if ($config.voice) { $voice = $config.voice }
}
$marks = [SystemVoice]::Render($req.text, (Join-Path $folder 'voice.wav'), $voice)
ConvertTo-Json -InputObject @($marks) -Depth 4 | Set-Content -LiteralPath (Join-Path $folder 'speech-marks.json') -Encoding UTF8
