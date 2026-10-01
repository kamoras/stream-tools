'use strict';

const killers = require('../data/killers');
const survivors = require('../data/survivors');
const perks = require('../data/perks');
const maps = require('../data/maps');

const ENTITY_LINES = [
  'The Entity grows impatient... More hooks. NOW.',
  'The Entity watches from the fog, pleased with your suffering.',
  'The Entity whispers: "No one escapes death."',
  'The Entity has consumed another soul into the fog.',
  'The Entity demands more sacrifice. The trials never end.',
  'The Entity sees all. There is no escape from the fog.',
  'The Entity stirs. A new trial is about to begin...',
  'The Entity is eternal. Your struggle merely feeds it.',
  'The Entity offers a gift: hope. Then takes it away.',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function handle(client, channel, tags, cmd, args) {
  const username = tags['display-name'] || tags.username;

  switch (cmd) {
    case 'killer':
      client.say(channel, `@${username}, your random killer: ${pick(killers)}`);
      break;

    case 'survivor':
      client.say(channel, `@${username}, your random survivor: ${pick(survivors)}`);
      break;

    case 'perk': {
      const side = args[0]?.toLowerCase();
      const perkPool =
        side === 'killer'
          ? perks.killer
          : side === 'survivor'
            ? perks.survivor
            : [...perks.survivor, ...perks.killer];
      client.say(channel, `@${username}, your random perk: ${pick(perkPool)}`);
      break;
    }

    case 'map':
      client.say(channel, `@${username}, your random map: ${pick(maps)}`);
      break;

    case 'entity':
      client.say(channel, pick(ENTITY_LINES));
      break;

    default:
      break;
  }
}

module.exports = { handle };
