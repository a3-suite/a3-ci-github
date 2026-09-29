export type FlagHandler = (value: string) => void;

// CLI ごとの必須条件と診断は各入口が所有し、ここでは値付きフラグの走査だけを共有する。
export const parseFlagArguments = (argv: string[], handlers: Record<string, FlagHandler>): void => {
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (!Object.hasOwn(handlers, flag)) throw new Error(`unknown argument: ${flag}`);
    handlers[flag]!(value);
    index += 1;
  }
};
