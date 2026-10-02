# @strudel/cli

Plays Strudel code from the command line, in real time, with MIDI output. There is no audio in Node:
patterns sound through outputs such as `.midi()`.

```sh
pnpm strudel play song.strudel --watch   # from the repo root
pnpm strudel midi-outputs                # list MIDI outputs
```

`song.strudel` is written as in the REPL (`$:` blocks, mini-notation in double quotes):

```js
setcps(0.5)
midicmd("clock*48").midi('Midi Through Port-0')
$: note("<c3 eb3 g3>*4").midi('Midi Through Port-0')
```

- `--watch` re-evaluates the file on every save. If the new code fails, the error is printed with
  its line and column, and the previous pattern keeps playing.
- `.midi(name)` picks the output whose name equals `name`, or contains it; without a name, the
  first output. Supported: `note`, `velocity` (0-1) times `gain`, `midichan`, `ccn`/`ccv`,
  `progNum`, and `midicmd` (`clock`, `start`, `stop`, `continue`).
- MIDI goes out through [jzz](https://jazz-soft.net/doc/JZZ/), outputs only. Each message is sent
  at its scheduled time on a timer plus a short spin, which keeps MIDI clock jitter well under 1 ms
  (capability SYNC-1).
