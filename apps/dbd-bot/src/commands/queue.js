'use strict';

function isMod(tags, channel) {
  return (
    tags.mod === true ||
    tags.badges?.broadcaster === '1' ||
    tags.username?.toLowerCase() === channel.replace(/^#/, '').toLowerCase()
  );
}

function formatEntries(entries) {
  return entries
    .map((e, i) => {
      const role = e.role ? ` (${e.role[0].toUpperCase()})` : '';
      return `#${i + 1} ${e.username}${role}`;
    })
    .join(' · ');
}

// Formats a prefixed command correctly whether or not the prefix has a trailing space.
function c(prefix, name) {
  const p = prefix.trimEnd();
  return p.length > 1 ? `${p} ${name}` : `${p}${name}`;
}

function handle(client, channel, tags, queue, cmd, args, config) {
  const username = tags['display-name'] || tags.username;
  const mod = isMod(tags, channel);
  const p = config.prefix;

  switch (cmd) {
    case 'join': {
      const result = queue.join(username, args[0]);
      if (!result.success && result.code === 'INVALID_ROLE') {
        client.say(channel, `@${username}, use ${c(p, 'join')} to join as survivor (default) or ${c(p, 'join')} killer to join as killer.`);
      } else {
        client.say(channel, result.message);
      }
      break;
    }

    case 'leave': {
      const result = queue.leave(username);
      client.say(channel, result.message);
      break;
    }

    case 'queue':
    case 'q': {
      if (queue.size === 0) {
        const hint = config.rolesMode === 'both'
          ? `Use ${c(p, 'join')} (survivor) or ${c(p, 'join')} killer.`
          : `Use ${c(p, 'join')} to sign up.`;
        client.say(channel, `The queue is empty! ${hint}`);
        break;
      }
      const status = queue.isOpen ? 'Open' : 'Closed';
      const preview = queue.list(5);
      const more = queue.size > 5 ? ` · +${queue.size - 5} more` : '';
      client.say(channel, `Queue [${status}] ${queue.size} total: ${formatEntries(preview)}${more}`);
      break;
    }

    case 'position':
    case 'pos': {
      const pos = queue.position(username);
      if (pos === 0) {
        const hint = config.rolesMode === 'both'
          ? `${c(p, 'join')} or ${c(p, 'join')} killer`
          : c(p, 'join');
        client.say(channel, `@${username}, you're not in the queue. Use ${hint} to sign up!`);
      } else {
        client.say(channel, `@${username}, you're #${pos} in the queue (${queue.size} total).`);
      }
      break;
    }

    case 'next': {
      if (!mod) break;
      const resultNext = queue.next();
      client.say(channel, resultNext.message);
      break;
    }

    case 'pick': {
      if (!mod) break;
      const count = args[0] ? Math.max(1, parseInt(args[0], 10) || 1) : 1;
      const resultPick = queue.pick(count);
      client.say(channel, resultPick.message);
      break;
    }

    case 'remove': {
      if (!mod) break;
      const target = args[0]?.replace(/^@/, '');
      if (!target) {
        client.say(channel, `@${username}, usage: ${c(p, 'remove')} <username>`);
        break;
      }
      const resultRemove = queue.remove(target);
      client.say(channel, resultRemove.message);
      break;
    }

    case 'clear': {
      if (!mod) break;
      const resultClear = queue.clear();
      client.say(channel, resultClear.message);
      break;
    }

    case 'open': {
      if (!mod) break;
      const resultOpen = queue.open();
      if (resultOpen.success) {
        const hint = config.rolesMode === 'both'
          ? `${c(p, 'join')} or ${c(p, 'join')} killer`
          : c(p, 'join');
        client.say(channel, `${resultOpen.message} Type ${hint} to get in line.`);
      } else {
        client.say(channel, resultOpen.message);
      }
      break;
    }

    case 'close': {
      if (!mod) break;
      const resultClose = queue.close();
      client.say(channel, resultClose.message);
      break;
    }

    case 'help': {
      if (args[0]?.toLowerCase() === 'extended') {
        const joinHint = config.rolesMode === 'both' ? `${c(p, 'join')} [killer]` : c(p, 'join');
        client.say(
          channel,
          `Dead by Daylight Queue — Everyone: ${joinHint} | ${c(p, 'leave')} | ${c(p, 'queue')} | ${c(p, 'position')} | ${c(p, 'killer')} | ${c(p, 'survivor')} | ${c(p, 'perk')} [killer/survivor] | ${c(p, 'map')} | ${c(p, 'entity')}` +
          ` — Mods: ${c(p, 'open')} | ${c(p, 'close')} | ${c(p, 'pick')} [n] | ${c(p, 'next')} | ${c(p, 'remove')} <user> | ${c(p, 'clear')}`
        );
      } else {
        client.say(
          channel,
          `Queue: ${c(p, 'join')} to sign up | ${c(p, 'leave')} to drop out | ${c(p, 'queue')} to see the list | ${c(p, 'position')} for your spot` +
          ` — Mods: ${c(p, 'open')} | ${c(p, 'close')} | ${c(p, 'pick')} [n]` +
          ` — ${c(p, 'help')} extended for all commands`
        );
      }
      break;
    }

    default:
      break;
  }
}

module.exports = { handle };
