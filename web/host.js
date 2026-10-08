export let app;
export let api;
export function configureHost(hostApp, hostApi) {
  app = hostApp;
  api = hostApi;
  if (!document.querySelector('link[data-voice-workbench]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.dataset.voiceWorkbench = 'true';
    css.href = new URL('./prosody_editor.css', import.meta.url).href;
    document.head.appendChild(css);
  }
}
