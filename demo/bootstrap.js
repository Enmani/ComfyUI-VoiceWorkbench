import { configureHost } from '/web/host.js';
import { ProsodyEditor } from '/web/editor.js';
configureHost({}, { fetchApi:(url, options)=>fetch(url, options), apiURL:url=>url });
const editor = new ProsodyEditor();
editor.mount(document.getElementById('workbench'));
try {
  await editor.open('');
} catch(error) {
  editor.setStatus(`Could not load the example: ${error.message}`, 'error');
}
