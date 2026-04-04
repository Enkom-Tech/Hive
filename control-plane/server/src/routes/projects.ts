import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "@hive/db";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  isUuidLike,
  optionalCompanyIdQuerySchema,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
} from "@hive/shared";
import { projectService, logActivity } from "../services/index.js";
import { conflict } from "../errors.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "./authz.js";

export async function projectsPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const svc = projectService(db);

  async function resolveProjectId(req: FastifyRequest, rawId: string): Promise<string> {
    if (isUuidLike(rawId)) return rawId;
    const query = optionalCompanyIdQuerySchema.safeParse((req as FastifyRequest & { query: unknown }).query);
    const requestedCompanyId = query.success ? (query.data.companyId ?? null) : null;
    let companyId = requestedCompanyId;
    if (!companyId) {
      const p = req.principal;
      if (p?.type === "agent" && p.company_id) companyId = p.company_id;
    }
    if (!companyId) return rawId;
    if (requestedCompanyId) await assertCompanyRead(db, req, companyId);
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    return resolved.project?.id ?? rawId;
  }

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/projects",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      return reply.send(await svc.list(companyId));
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/projects/:id",
    async (req, reply) => {
      const id = await resolveProjectId(req, req.params.id);
      const project = await svc.getById(id);
      if (!project) return reply.status(404).send({ error: "Project not found" });
      await assertCompanyRead(db, req, project.companyId);
      return reply.send(project);
    },
  );

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/projects",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "projects:write");
      const parsed = createProjectSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      type Workspace = Parameters<typeof svc.createWorkspace>[1];
      const { workspace, archivedAt: archivedAtRaw, ...projectData } = parsed.data as typeof parsed.data & { workspace?: Workspace; archivedAt?: string | null };
      const project = await svc.create(companyId, { ...projectData, archivedAt: archivedAtRaw ? new Date(archivedAtRaw) : null } as Parameters<typeof svc.create>[1]);
      let createdWorkspaceId: string | null = null;
      if (workspace) {
        const createdWorkspace = await svc.createWorkspace(project.id, workspace);
        if (!createdWorkspace) { await svc.remove(project.id); return reply.status(422).send({ error: "Invalid project workspace payload" }); }
        createdWorkspaceId = createdWorkspace.id;
      }
      const hydratedProject = workspace ? await svc.getById(project.id) : project;
      const actor = getActorInfo(req);
      await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "project.created", entityType: "project", entityId: project.id, details: { name: project.name, workspaceId: createdWorkspaceId } });
      return reply.status(201).send(hydratedProject ?? project);
    },
  );

  fastify.patch<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/projects/:id",
    async (req, reply) => {
      const id = await resolveProjectId(req, req.params.id);
      const existing = await svc.getById(id);
      if (!existing) return reply.status(404).send({ error: "Project not found" });
      await assertCompanyPermission(db, req, existing.companyId, "projects:write");
      const parsed = updateProjectSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const { archivedAt: archivedAtRaw, ...updateData } = parsed.data as typeof parsed.data & { archivedAt?: string | null };
      const project = await svc.update(id, { ...updateData, archivedAt: archivedAtRaw ? new Date(archivedAtRaw) : undefined } as Parameters<typeof svc.update>[1]);
      if (!project) return reply.status(404).send({ error: "Project not found" });
      const actor = getActorInfo(req);
      await logActivity(db, { companyId: project.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "project.updated", entityType: "project", entityId: project.id, details: parsed.data });
      return reply.send(project);
    },
  );

  fastify.delete<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/projects/:id",
    async (req, reply) => {
      const id = await resolveProjectId(req, req.params.id);
      const existing = await svc.getById(id);
      if (!existing) return reply.status(404).send({ error: "Project not found" });
      await assertCompanyPermission(db, req, existing.companyId, "projects:write");
      const project = await svc.remove(id);
      if (!project) return reply.status(404).send({ error: "Project not found" });
      const actor = getActorInfo(req);
      await logActivity(db, { companyId: project.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "project.deleted", entityType: "project", entityId: project.id });
      return reply.send(project);
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/projects/:id/workspaces",
    async (req, reply) => {
      const id = await resolveProjectId(req, req.params.id);
      const existing = await svc.getById(id);
      if (!existing) return reply.status(404).send({ error: "Project not found" });
      await assertCompanyRead(db, req, existing.companyId);
      return reply.send(await svc.listWorkspaces(id));
    },
  );

  fastify.post<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/projects/:id/workspaces",
    async (req, reply) => {
      const id = await resolveProjectId(req, req.params.id);
      const existing = await svc.getById(id);
      if (!existing) return reply.status(404).send({ error: "Project not found" });
      await assertCompanyPermission(db, req, existing.companyId, "projects:write");
      const parsed = createProjectWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const workspace = await svc.createWorkspace(id, parsed.data);
      if (!workspace) return reply.status(422).send({ error: "Invalid project workspace payload" });
      const actor = getActorInfo(req);
      await logActivity(db, { companyId: existing.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "project.workspace_created", entityType: "project", entityId: id, details: { workspaceId: workspace.id, name: workspace.name, cwd: workspace.cwd, isPrimary: workspace.isPrimary } });
      return reply.status(201).send(workspace);
    },
  );

  fastify.patch<{ Params: { id: string; workspaceId: string }; Querystring: Record<string, unknown> }>(
    "/api/projects/:id/workspaces/:workspaceId",
    async (req, reply) => {
      const id = await resolveProjectId(req, req.params.id);
      const { workspaceId } = req.params;
      const existing = await svc.getById(id);
      if (!existing) return reply.status(404).send({ error: "Project not found" });
      await assertCompanyPermission(db, req, existing.companyId, "projects:write");
      const workspaceExists = (await svc.listWorkspaces(id)).some((w) => w.id === workspaceId);
      if (!workspaceExists) return reply.status(404).send({ error: "Project workspace not found" });
      const parsed = updateProjectWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const workspace = await svc.updateWorkspace(id, workspaceId, parsed.data);
      if (!workspace) return reply.status(422).send({ error: "Invalid project workspace payload" });
      const actor = getActorInfo(req);
      await logActivity(db, { companyId: existing.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "project.workspace_updated", entityType: "project", entityId: id, details: { workspaceId: workspace.id, changedKeys: Object.keys(parsed.data).sort() } });
      return reply.send(workspace);
    },
  );

  fastify.delete<{ Params: { id: string; workspaceId: string }; Querystring: Record<string, unknown> }>(
    "/api/projects/:id/workspaces/:workspaceId",
    async (req, reply) => {
      const id = await resolveProjectId(req, req.params.id);
      const { workspaceId } = req.params;
      const existing = await svc.getById(id);
      if (!existing) return reply.status(404).send({ error: "Project not found" });
      await assertCompanyPermission(db, req, existing.companyId, "projects:write");
      const workspace = await svc.removeWorkspace(id, workspaceId);
      if (!workspace) return reply.status(404).send({ error: "Project workspace not found" });
      const actor = getActorInfo(req);
      await logActivity(db, { companyId: existing.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "project.workspace_deleted", entityType: "project", entityId: id, details: { workspaceId: workspace.id, name: workspace.name } });
      return reply.send(workspace);
    },
  );
}
