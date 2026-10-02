import { invoke } from '@tauri-apps/api/core';

export const Invoke = invoke;
// __TAURI_INTERNALS__ in Tauri 2, __TAURI_IPC__ in Tauri 1
export const isTauri = () => window.__TAURI_INTERNALS__ != null || window.__TAURI_IPC__ != null;
