import type { Migration } from "../index";
import * as init from "./0001-init";
import * as adminIdentity from "./0002-admin-identity";

// Filename order is application order (spec 0001 §9.3). New migrations append.
export const migrations: Migration[] = [
  { name: "0001-init", up: init.up },
  { name: "0002-admin-identity", up: adminIdentity.up },
];
