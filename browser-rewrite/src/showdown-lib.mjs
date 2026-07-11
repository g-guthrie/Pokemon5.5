// Single doorway to the Pokémon Showdown simulator. Node loads the pinned
// vendor checkout; the static browser build aliases this module to
// src/browser/showdown-lib.mjs (@pkmn/sim), so nothing else in src/ may
// require the vendor package directly.
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const showdownRoot = path.join(rootDir, 'vendor', 'pokemon-showdown');
const {BattleStream, getPlayerStreams, Teams, Dex} = require(showdownRoot);

export {BattleStream, getPlayerStreams, Teams, Dex};
