// Browser build of the simulator doorway (see src/showdown-lib.mjs, which
// this file replaces via esbuild alias). @pkmn/sim is the maintained
// browser-bundlable build of the same Pokémon Showdown engine; @pkmn/randoms
// supplies the random-battle team generators the vendor package loads with
// dynamic requires.
import {BattleStreams, Dex, Teams} from '@pkmn/sim';
import {TeamGenerators} from '@pkmn/randoms';

Teams.setGeneratorFactory(TeamGenerators);

export const BattleStream = BattleStreams.BattleStream;
export const getPlayerStreams = BattleStreams.getPlayerStreams;
export {Teams, Dex};
