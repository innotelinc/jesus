import { publisher } from './constants.ts'
import { base } from './factory/base.ts'

import type { SecretAgentDefinition } from './types/secret-agent-definition.ts'

const definition: SecretAgentDefinition = {
  id: 'base-lite',
  publisher,
  ...base('openai/gpt-5', 'lite'),
  reasoningOptions: {
    enabled: true,
    effort: 'medium',
    exclude: true,
  },
  toolNames: [
    'create_plan',
    'run_terminal_command',
    'str_replace',
    'write_file',
    'spawn_agents',
    'spawn_agent_inline',
    'add_subgoal',
    'browser_logs',
    'code_search',
    'read_files',
    'update_subgoal',
  ],
  spawnableAgents: [
    'file-explorer',
    'web-researcher',
    'docs-researcher',
    'context-pruner',
  ],
}

export default definition
