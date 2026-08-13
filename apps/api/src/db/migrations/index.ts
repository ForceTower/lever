import type { Migration } from "../index";
import * as init from "./0001-init";

// Filename order is application order (spec 0001 §9.3). New migrations append.
export const migrations: Migration[] = [{ name: "0001-init", up: init.up }];
