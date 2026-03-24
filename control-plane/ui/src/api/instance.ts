import type { InstanceStatusMigrationApplyResponse, InstanceStatusResponse } from "@hive/shared";
import { api } from "./client";

export type CreatedInstanceUser = {
  id: string;
  email: string;
  name: string;
};

export const instanceApi = {
  createUser: (input: { email: string; name: string; password: string }) =>
    api.post<CreatedInstanceUser>("/instance/users", input),
  getStatus: () => api.get<InstanceStatusResponse>("/instance/status"),
  applyMigrations: () =>
    api.post<InstanceStatusMigrationApplyResponse>("/instance/migrations/apply", {}),
};
