// Reference song for render probes: the pattern from packages/supradough/dough-export.mjs,
// synth-only so it needs no network. Builds with global pattern functions after evalScope.
/* global note, s, chord, sine, press, add, ply, rev */
import { loadScope } from './scope.mjs';

export const REFERENCE = { cps: 0.5, cycles: 32, tail: 1, sampleRate: 48000 };

export async function referenceSong() {
  await loadScope();
  return buildReferenceSong();
}

export function buildReferenceSong() {
  return note('c,eb,g,<bb c4 d4 eb4>')
    .s('sine')
    .press()
    .add(note(24))
    .fmi(3)
    .fmh(5.01)
    .dec(0.4)
    .delay('.6:<.12 .22>:.8')
    .jux(press)
    .rarely(add(note('12')))
    .lpf(400)
    .lpq(0.2)
    .lpd(0.4)
    .lpenv(3)
    .fmdecay(0.4)
    .fmenv(1)
    .postgain(0.6)
    .stack(s('<pink white>*8').dec(0.07).rarely(ply('2')).delay(0.5).hpf(sine.range(200, 2000).slow(4)).hpq(0.2))
    .stack(
      s('[- white@3]*2')
        .dec(0.4)
        .hpf('<2000!3 <4000 8000>>*4')
        .hpq(0.6)
        .ply('<1 2>*4')
        .postgain(0.5)
        .delay(0.5)
        .jux(rev)
        .lpf(5000),
    )
    .stack(
      note('<c2 - [- f1] ->*2')
        .s('square')
        .lpf(sine.range(100, 300).slow(4))
        .lpe(1)
        .segment(8)
        .lpd(0.3)
        .lpq(0.2)
        .dec(0.2)
        .speed('<1 2>')
        .ply('<1 2>')
        .postgain(1),
    )
    .stack(
      chord('<Cm Cm7 Cm9 Cm11 Fm Fm7 Fm9 Fm11>')
        .voicing()
        .s('<sine>')
        .clip(1)
        .rel(0.4)
        .vib('4:.2')
        .gain(0.7)
        .hpf(1200)
        .fm(0.5)
        .att(1)
        .lpa(0.5)
        .lpf(200)
        .lpenv(4)
        .chorus(0.8),
    );
}
