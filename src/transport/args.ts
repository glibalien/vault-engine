export interface ParsedArgs {
  dbPath: string | undefined;
  vaultPath: string | undefined;
  transport: 'stdio' | 'http' | 'both';
  port: number;
}

const VALID_TRANSPORTS = new Set(['stdio', 'http', 'both']);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    dbPath: undefined,
    vaultPath: undefined,
    transport: 'stdio',
    port: 3333,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--transport') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --transport. Must be stdio, http, or both.');
      }
      const value = argv[++i];
      if (!VALID_TRANSPORTS.has(value)) {
        throw new Error(`Invalid --transport value: "${value}". Must be stdio, http, or both.`);
      }
      result.transport = value as ParsedArgs['transport'];
    } else if (arg === '--port') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --port. Must be an integer between 1 and 65535.');
      }
      const value = argv[++i];
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(`Invalid --port value: "${value}". Must be an integer between 1 and 65535.`);
      }
      result.port = num;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length >= 1) result.dbPath = positional[0];
  if (positional.length >= 2) result.vaultPath = positional[1];

  return result;
}
