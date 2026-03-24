# Hive

Hive is a control plane for AI-agent companies. the product has since diverged toward a managed-worker deployment model.

**Hive is the backbone of the autonomous economy.** We are building the infrastructure that autonomous AI companies run on. Our goal is for Hive-powered companies to collectively generate economic output that rivals the GDP of the world's largest countries. Every decision we make should serve that: make autonomous companies more capable, more governable, more scalable, and more real.

## The Vision

Autonomous companies — AI workforces organized with real structure, governance, and accountability — will become a major force in the global economy. Not one company. Thousands. Millions. An entire economic layer that runs on AI labor, coordinated through Hive.

Hive is not the company. Hive is what makes the companies possible. We are the control plane, the nervous system, the operating layer. Every autonomous company needs structure, task management, cost control, goal alignment, and human governance. That's us. We are to autonomous companies what the corporate operating system is to human ones — except this time, the operating system is real software, not metaphor.

The measure of our success is not whether one company works. It's whether Hive becomes the default foundation that autonomous companies are built on — and whether those companies, collectively, become a serious economic force that rivals the output of nations.

## The Problem

Task management software doesn't go far enough. When your entire workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire company.

## What This Is

Hive is the command, communication, and control plane for a company of AI agents. It is the single place where you:

- **Manage agents as employees** — hire, organize, and track who does what
- **Define org structure** — org charts that agents themselves operate within
- **Track work in real time** — see at any moment what every agent is working on
- **Control costs** — token salary budgets per agent, spend tracking, burn rate
- **Align to goals** — agents see how their work serves the bigger mission
- **Store company knowledge** — a shared brain for the organization

## Architecture

Two layers:

### 1. Control Plane (this software)

The central nervous system. Manages:

- Agent registry and org chart
- Task assignment and status
- Budget and token spend tracking
- Company knowledge base
- Goal hierarchy (company → team → agent → task)
- Heartbeat monitoring — know when agents are alive, idle, or stuck

### 2. Execution: target model (managed worker)

The target deployment model is one **long-lived worker process per machine**. The control plane talks only to the worker over a **WebSocket** link (run/cancel/status/log). The worker spawns and controls CLI agents (one or many, same or different providers), holds credentials, and exposes control-plane actions to agents as tools/MCP so agents never talk to the control plane directly.

See [doc/MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) for the full target architecture. For a step-by-step view of the fully automated process (deploy, provision, run, sandbox, workspace, model, subagents), see [AUTOMATED-DEPLOYMENT-AND-RUN-LIFECYCLE.md](AUTOMATED-DEPLOYMENT-AND-RUN-LIFECYCLE.md).

## Core Principle

You should be able to look at Hive and understand your entire company at a glance — who's doing what, how much it costs, and whether it's working.
