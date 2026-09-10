// src/messages/polls.js — polls live in memory, per room, and are never
// persisted. The tally is COMPUTED at serialisation time and never stored, so
// the tally and the votes cannot disagree.
'use strict';

const { newId } = require('../state/hub');

function create({ q, options, by, colour, enc }) {
  return {
    id: newId('poll'),
    q,
    options,
    by,
    colour,
    ts: Date.now(),
    closed: false,
    votes: new Map(), // username -> option index
    enc: enc || null, // in a locked room, q and options travel as one envelope
  };
}

function vote(poll, username, choice) {
  if (poll.closed) return false;
  if (!Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) return false;
  if (poll.votes.get(username) === choice) {
    poll.votes.delete(username); // voting the same option twice withdraws
  } else {
    poll.votes.set(username, choice);
  }
  return true;
}

function serialize(poll) {
  const tally = new Array(poll.options.length).fill(0);
  const voters = {};
  for (const [user, choice] of poll.votes) {
    if (choice >= 0 && choice < tally.length) tally[choice]++;
    voters[user] = choice;
  }
  return {
    id: poll.id,
    q: poll.q,
    options: poll.options,
    by: poll.by,
    colour: poll.colour,
    ts: poll.ts,
    closed: poll.closed,
    tally,
    total: poll.votes.size,
    voters,
    enc: poll.enc,
  };
}

module.exports = { create, vote, serialize };
