import { config } from "./config.js";
import { FairConcurrencyPool, KeyedMutex } from "./concurrency.js";

export const processPool = new FairConcurrencyPool(
  "processes",
  config.maxConcurrentProcesses,
  Math.min(config.maxConcurrentProcesses, config.maxConcurrentProcessesPerWorkspace)
);

export const searchPool = new FairConcurrencyPool(
  "searches",
  config.maxConcurrentSearches,
  Math.min(config.maxConcurrentSearches, config.maxConcurrentSearchesPerWorkspace)
);

export const ioPool = new FairConcurrencyPool(
  "filesystem-io",
  config.maxConcurrentIo,
  Math.min(config.maxConcurrentIo, config.maxConcurrentIoPerWorkspace)
);

export const fileLocks = new KeyedMutex();

export function concurrencySnapshot() {
  return {
    processes: processPool.snapshot(),
    searches: searchPool.snapshot(),
    filesystemIo: ioPool.snapshot(),
    fileLocks: fileLocks.snapshot()
  };
}
