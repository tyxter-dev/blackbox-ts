import { packWorkspaceAgent } from 'blackbox-ts/workspace-agents';

const archive = packWorkspaceAgent({
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  instructions: 'Help.',
  model: 'openai:gpt-5.4',
  tools: [],
  connectors: [],
  mcp_servers: [],
  permissions: {},
  schedules: [],
  skills: [],
  visibility: 'private',
  metadata: {},
});
console.log(archive.byteLength);
