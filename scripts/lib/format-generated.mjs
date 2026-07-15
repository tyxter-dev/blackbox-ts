import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

export async function formatGenerated(content, path) {
  const filepath = path instanceof URL ? fileURLToPath(path) : path;
  const config = (await resolveConfig(filepath)) ?? {};
  return format(content, { ...config, filepath });
}
