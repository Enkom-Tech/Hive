import type { StandupReport } from "@hive/shared";
import { api } from "./client";

export const standupApi = {
  get: (companyId: string) =>
    api.get<StandupReport>(`/companies/${companyId}/standup`),
};
