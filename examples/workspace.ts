import { LocalWorkspaceProvider } from '@tyxter/blackbox-ts/workspaces';

const workspace = await new LocalWorkspaceProvider().open({ kind: 'local', ref: process.cwd() });
console.log(await workspace.list('.'));
await workspace.close();
