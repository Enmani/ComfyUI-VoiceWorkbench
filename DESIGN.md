# Interface design

Preserve the original workbench's sentence timeline, source-time pitch curve, duration handles and recording comparison. Use dark neutral surfaces and one teal interface accent. Gold pitch points, blue word handles and purple pauses are content indicators, with labels and keyboard controls.

The shared CSS owns palette, font, radius, spacing and shadow tokens. Text is 16 px, supporting metadata 14 px and headings 20 px at the default browser scale. Duration geometry remains proportional to real audio time; labels may truncate with full text available through accessible names. The timeline can scroll independently and can fit the full sentence.

Every generated take appears as a candidate with playback, comparison, explicit application and version restoration. Loading, disabled, error, stale-preview and saved states have visible text. Local draft recovery never silently binds an old curve to a new waveform.
