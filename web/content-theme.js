// Canvas content uses the same CSS-owned palette and font scale as the editor.
export function contentTheme(root) {
  const style = getComputedStyle(root || document.documentElement);
  const value = name => style.getPropertyValue(`--ds-content-${name}`).trim();
  return {
    selection:value('selection'), axis:value('axis'), stale:value('stale'),
    waveformSource:value('waveform-source'), output:value('output'), playhead:value('playhead'),
    shade:value('shade'), voiced:value('voiced'), grid:value('grid'), label:value('label'),
    pitchSource:value('pitch-source'), target:value('target'), tail:value('tail'),
    wordHighlight:value('word-highlight'), relativeGrid:value('relative-grid'),
    zero:value('zero'), invalid:value('invalid'), curve:value('curve'),
    font:`${style.getPropertyValue('--ds-font-meta').trim()} system-ui`,
  };
}
