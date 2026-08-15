import { createHono } from "../index";
import { adminAudit, adminAuth } from "../middleware";
import { accountRoutes, sessionRoutes } from "./accounts";
import { authRoutes } from "./auth";
import { conditionRoutes } from "./conditions";
import { environmentRoutes } from "./environments";
import { parameterRoutes } from "./parameters";
import { projectRoutes } from "./projects";
import { versionRoutes } from "./versions";

/**
 * The §8.2 admin surface, mounted under /v1/admin. Two tiers: `/auth` owns the
 * ceremonies that must be reachable without a session, and everything else sits
 * behind `adminAuth` → `adminAudit` → a per-route `requirePermission`.
 *
 * Registration order is load-bearing: Hono runs matching entries in the order
 * they were added, so mounting `/auth` first lets it answer before the guard
 * below can reject an as-yet-unauthenticated caller.
 */
export const adminRoutes = createHono();

adminRoutes.route("/auth", authRoutes);

const guarded = createHono();
guarded.use("*", adminAuth());
// After adminAuth, so a rejected login is never written to the audit log, and
// before the route handlers, so their thrown 4xx still gets recorded.
guarded.use("*", adminAudit());
guarded.route("/accounts", accountRoutes);
guarded.route("/sessions", sessionRoutes);
guarded.route("/", projectRoutes);
guarded.route("/", environmentRoutes);
guarded.route("/", conditionRoutes);
guarded.route("/", parameterRoutes);
guarded.route("/", versionRoutes);

adminRoutes.route("/", guarded);
