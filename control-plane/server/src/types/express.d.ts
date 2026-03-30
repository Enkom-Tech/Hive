import type { Principal } from "@hive/shared";

declare global {
  namespace Express {
    interface Request {
      principal?: Principal | null;
    }
  }
}

export {};
