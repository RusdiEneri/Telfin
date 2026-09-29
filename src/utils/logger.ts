const timestamp = () => new Date().toISOString();

export const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[${timestamp()}] [INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[${timestamp()}] [WARN] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[${timestamp()}] [ERROR] ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.DEBUG === "true") {
      console.debug(`[${timestamp()}] [DEBUG] ${msg}`, ...args);
    }
  },
};
