export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Protects the admin. Set by bohr when the project is created (or: npx wrangler secret put ADMIN_PASSWORD). */
  ADMIN_PASSWORD?: string;
};

export type AppEnv = { Bindings: Bindings };
