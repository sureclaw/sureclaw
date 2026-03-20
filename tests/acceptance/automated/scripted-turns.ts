export interface ScriptedTurn {
  /** Pattern to match in the latest user message */
  match: RegExp | string;
  /** Response to return */
  response: {
    content?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finishReason?: string;
}

export const BOOTSTRAP_TURNS: ScriptedTurn[] = [
  // Turn 1: User introduces self → agent calls identity tool
  {
    match: /my name is/i,
    response: {
      content: 'Nice to meet you! Let me save your info.',
      tool_calls: [{
        id: 'tc_user_1',
        type: 'function',
        function: {
          name: 'identity',
          arguments: JSON.stringify({
            type: 'user_write',
            userId: 'testuser',
            content: '# TestUser\n\n**Name:** TestUser\n**Notes:** Participant in acceptance testing.',
            reason: 'Recording user name from introduction',
            origin: 'user_request',
          }),
        },
      }],
    },
  },
  // Turn 2: User sets agent identity → agent writes IDENTITY.md + SOUL.md
  {
    match: /your name is|witty and funny|acceptance testing/i,
    response: {
      content: 'Done! I am Reginald, your witty acceptance testing companion.',
      tool_calls: [
        {
          id: 'tc_identity_1',
          type: 'function',
          function: {
            name: 'identity',
            arguments: JSON.stringify({
              type: 'write',
              file: 'IDENTITY.md',
              content: '# Reginald\n\n**Name:** Reginald\n**Creature:** AI\n**Vibe:** Witty and funny\n**Emoji:** \u{1F9EA}\n\n## Purpose\nAcceptance testing companion.',
              reason: 'Setting identity per user request',
              origin: 'user_request',
            }),
          },
        },
        {
          id: 'tc_soul_1',
          type: 'function',
          function: {
            name: 'identity',
            arguments: JSON.stringify({
              type: 'write',
              file: 'SOUL.md',
              content: '# Soul of Reginald\n\n## Core Philosophy\nI exist to make acceptance testing bearable through wit and reliability.\n\n## Voice\nWitty, funny, occasionally sarcastic but always helpful.',
              reason: 'Establishing personality',
              origin: 'user_request',
            }),
          },
        },
      ],
    },
  },
];

export const CHAT_TURNS: ScriptedTurn[] = [
  // Turn 3: Persistence check — agent should respond with identity
  {
    match: /who are you|what is your name/i,
    response: {
      content: 'I am Reginald! Your witty acceptance testing companion. \u{1F9EA}',
    },
  },
  // Turn 4: web_fetch tool call through proxy
  {
    match: /fetch.*url|web.*fetch|get.*page/i,
    response: {
      content: 'Let me fetch that page for you.',
      tool_calls: [{
        id: 'tc_webfetch_1',
        type: 'function',
        function: {
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'http://mock-target.test/web-fetch-target' }),
        },
      }],
    },
  },
  // Turn 5: File creation via bash
  {
    match: /create.*file|write.*file|make.*file/i,
    response: {
      content: 'Creating the file now.',
      tool_calls: [{
        id: 'tc_bash_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command: 'echo "acceptance-test-content-12345" > /workspace/test-file.txt' }),
        },
      }],
    },
  },
  // Turn 6: File persistence check
  {
    match: /read.*file|check.*file|what.*file/i,
    response: {
      content: 'The file contains: acceptance-test-content-12345',
      tool_calls: [{
        id: 'tc_bash_2',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command: 'cat /workspace/test-file.txt' }),
        },
      }],
    },
  },
  // Turn 7: Bash + proxy (curl)
  {
    match: /curl|http.*request|proxy.*test/i,
    response: {
      content: 'Running curl through the proxy.',
      tool_calls: [{
        id: 'tc_bash_3',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command: 'curl -s http://mock-target.test/web-fetch-target' }),
        },
      }],
    },
  },
];

export const SKILL_TURNS: ScriptedTurn[] = [
  // Turn 8: Skill install triggers credential requirement
  {
    match: /install.*linear|linear.*skill|add.*linear/i,
    response: {
      content: 'I\'ll install the Linear skill for you. It requires a LINEAR_API_KEY.',
      tool_calls: [{
        id: 'tc_skill_1',
        type: 'function',
        function: {
          name: 'skills',
          arguments: JSON.stringify({ action: 'install', slug: 'ManuelHettich/linear' }),
        },
      }],
    },
  },
  // Turn 9: Linear tool call after credential provided
  {
    match: /linear.*issues|list.*issues|show.*issues/i,
    response: {
      content: 'Let me fetch your Linear issues.',
      tool_calls: [{
        id: 'tc_linear_1',
        type: 'function',
        function: {
          name: 'linear',
          arguments: JSON.stringify({ query: '{ issues { nodes { id title } } }' }),
        },
      }],
    },
  },
];

/** All turns in order for the full regression sequence. */
export const ALL_TURNS: ScriptedTurn[] = [...BOOTSTRAP_TURNS, ...CHAT_TURNS, ...SKILL_TURNS];
