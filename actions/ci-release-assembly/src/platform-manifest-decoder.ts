import { parse } from 'yaml';

export const decodePlatformManifest = (text: string): unknown => parse(text, { maxAliasCount: 20, uniqueKeys: true });
