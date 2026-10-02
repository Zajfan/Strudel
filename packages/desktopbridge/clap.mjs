// Plugins in the desktop app: .clap(name) plays a pattern's notes on a CLAP instrument hosted by the
// Rust backend (src-tauri/src/audio/plugins.rs), instead of superdough. The plugin is looked up by
// file name ("Surge XT" for "Surge XT.clap") in CLAP_PATH, ~/.clap, /usr/lib/clap and
// /usr/lib64/clap, and loaded on first use. A stand-in for the VersaTone engine
// (docs/superpowers/plans/2026-10-02-native-desktop-audio.md).
import { Pattern, logger, noteToMidi } from '@strudel/core';
import { Invoke, toEpochMs } from './utils.mjs';

/**
 * Plays the pattern's notes on a CLAP instrument plugin (desktop app only).
 * Uses note, velocity (0-1, default 0.9) times gain, and each note's duration.
 * @name clap
 * @param {string} plugin the plugin's file name without .clap, e.g. 'Surge XT':
 *   note("c3 e3 g3 c4").clap('Surge XT')
 */
Pattern.prototype.clap = function (plugin) {
  return this.onTrigger((hap, currentTime, cps, targetTime) => {
    hap.ensureObjectValue();
    const { note, velocity = 0.9, gain = 1 } = hap.value;
    if (note == null) return;
    const key = typeof note === 'number' ? Math.round(note) : noteToMidi(note);
    const notes = [
      {
        time: toEpochMs(targetTime, currentTime),
        duration: (hap.duration.valueOf() / cps) * 1000,
        key,
        velocity: Math.min(1, gain * velocity),
      },
    ];
    Invoke('clap_play', { plugin, notes }).catch((err) => logger(`[clap] ${err}`, 'error'));
  });
};

// the CLAP plugins the desktop app can load, by name
export const clapPlugins = () => Invoke('clap_plugins');
