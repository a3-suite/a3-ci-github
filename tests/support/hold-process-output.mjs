import { afterAll, afterEach, beforeAll, vi } from 'vitest';

// Vitest's `silent` only covers console output. Code under test that writes straight to process.stdout/stderr
// would flood the shared log, so hold those writes and print them only for a test that failed.
export const holdProcessOutput = (streamName) => {
  const held = [];
  let write;
  beforeAll(() => {
    write = process[streamName].write.bind(process[streamName]);
    vi.spyOn(process[streamName], 'write').mockImplementation((chunk) => {
      held.push(chunk);
      return true;
    });
  });
  afterEach((context) => {
    if (context.task.result?.state === 'fail') for (const chunk of held.splice(0)) write(chunk);
    else held.length = 0;
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
};
