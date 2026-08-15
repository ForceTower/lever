import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { ConditionsPage } from "@/features/conditions/conditions-page";
import { ParameterPage } from "@/features/parameters/parameter-page";
import { ParametersPage } from "@/features/parameters/parameters-page";
import { ProjectPage } from "@/features/projects/project-page";
import { ProjectsPage } from "@/features/projects/projects-page";
import { PublishPage } from "@/features/publish/publish-page";
import { SettingsPage } from "@/features/settings/settings-page";

const rootRoute = createRootRoute({ component: AppShell });

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ProjectsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectPage,
});

const parametersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environments/$envId/parameters",
  component: ParametersPage,
});

const parameterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environments/$envId/parameters/$parameterId",
  component: ParameterPage,
});

const conditionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environments/$envId/conditions",
  component: ConditionsPage,
});

const publishRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environments/$envId/publish",
  component: PublishPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environments/$envId/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  projectsRoute,
  projectRoute,
  parametersRoute,
  parameterRoute,
  conditionsRoute,
  publishRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
