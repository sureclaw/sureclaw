import type { ScriptedTurn } from './types.js';

export const BOOTSTRAP_TURNS: ScriptedTurn[] = [
  // Turn 1: User introduces self → agent writes a note (no more USER.md)
  {
    match: /my name is/i,
    response: {
      content: 'Nice to meet you! I\'ll remember that.',
    },
  },
  // Turn 2: User sets agent identity → agent writes IDENTITY.md + SOUL.md to .ax/
  // Host commits changes automatically via hostGitCommit() after the turn.
  {
    match: /your name is|witty and funny|acceptance testing/i,
    response: {
      content: 'Done! I am Reginald, your witty acceptance testing companion.',
      tool_calls: [
        {
          id: 'tc_identity_1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: '.ax/IDENTITY.md',
              content: '# Reginald\n\n**Name:** Reginald\n**Creature:** AI\n**Vibe:** Witty and funny\n\n## Purpose\nAcceptance testing companion.',
            }),
          },
        },
        {
          id: 'tc_soul_1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: '.ax/SOUL.md',
              content: '# Soul of Reginald\n\n## Core Philosophy\nI exist to make acceptance testing bearable through wit and reliability.\n\n## Voice\nWitty, funny, occasionally sarcastic but always helpful.',
            }),
          },
        },
      ],
    },
  },
];
