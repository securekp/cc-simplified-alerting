/**
 * Globals the Cribl App platform installs on `window`. See AGENTS.md — these are
 * read-only and always present at runtime. Never define, assign, or polyfill them.
 */
declare global {
  interface Window {
    /** Base URL for all Cribl API calls, e.g. `https://localhost:9000/api/v1`. */
    readonly CRIBL_API_URL: string;
    /** Base path the app is mounted at, e.g. `/app-ui/cc-simplified-alerting`. */
    readonly CRIBL_BASE_PATH: string;
    /** App id, injected by the dev server and by the platform. */
    readonly CRIBL_APP_ID?: string;
    /** Identity of the signed-in Cribl user. Memoized by the platform. */
    readonly getCriblUser?: () => Promise<{
      id: string;
      username: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      initials?: string;
    }>;
  }
}

export {};
