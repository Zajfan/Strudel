/*
fallbackquery.mjs - lets a scheduler keep playing the previous pattern when a new one fails at query time
Copyright (C) 2022 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/core/fallbackquery.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import State from './state.mjs';
import TimeSpan from './timespan.mjs';
import { errorLogger } from './logger.mjs';

// The scheduler keeps `pattern` (what it plays) plus `fallbackPattern`: the pattern it replaced,
// if that one had queried cleanly. A pattern counts as healthy once one of its queries succeeds.

export function setScheduledPattern(scheduler, pattern) {
  if (scheduler.pattern && scheduler.patternHealthy) {
    scheduler.fallbackPattern = scheduler.pattern;
  }
  scheduler.pattern = pattern;
  scheduler.patternHealthy = false;
}

// Unlike Pattern.queryArc, this does not swallow query errors (queryArc returns [] on error, which
// silences playback without telling anyone). When the current pattern throws and there is a healthy
// pattern to fall back to, the error is reported once and the scheduler switches back to that pattern.
// Otherwise the error is thrown to the caller.
export function queryScheduledPattern(scheduler, begin, end, controls, onError) {
  const state = new State(new TimeSpan(begin, end), controls);
  try {
    const haps = scheduler.pattern.query(state);
    scheduler.patternHealthy = true;
    return haps;
  } catch (err) {
    const fallback = scheduler.fallbackPattern;
    if (!fallback || fallback === scheduler.pattern) {
      throw err;
    }
    errorLogger(err, 'cyclist');
    onError?.(err);
    scheduler.pattern = fallback;
    scheduler.fallbackPattern = undefined;
    scheduler.patternHealthy = true;
    return fallback.query(state);
  }
}
