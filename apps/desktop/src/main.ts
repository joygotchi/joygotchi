import { mount } from 'svelte';
import App from './App.svelte';
import { installTauriMock } from './mock-tauri';

// Before anything imports `@tauri-apps/api`, so the UI can be opened in a
// browser during development. A no-op inside the real window, and compiled
// out of a build.
installTauriMock();

export default mount(App, { target: document.getElementById('app')! });
