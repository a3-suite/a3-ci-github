export type ResultEntry = { id: string; status: string; reason?: string };

// Only the not-run of an unconfigured optional command is excluded; the status is success exactly when every other result succeeded.
export const statusMatchesResults = (payload: { status: string; results: ResultEntry[] }): boolean => {
  const remaining = payload.results.filter((entry) => !(entry.status === 'not-run' && entry.reason === 'not-configured'));
  return (payload.status === 'success') === remaining.every((entry) => entry.status === 'success');
};
