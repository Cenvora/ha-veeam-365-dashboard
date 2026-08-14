/**
 * Tests for the dashboard strategy.
 *
 * Zero dependencies: node:test plus the module itself, which is plain ESM with no build step.
 * The registry fixtures mirror what Home Assistant returns for the ha-veeam-365 integration,
 * including the entity_category, original_name and platform fields the layout depends on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboard, buildSections, buildView } from "../veeam-365-dashboard.js";

const ENTRY = "entry-1";
const ENTRY_2 = "entry-2";

function device(id, name, model, entry = ENTRY, extra = {}) {
  return {
    id,
    name,
    name_by_user: null,
    model,
    manufacturer: "Veeam",
    config_entries: [entry],
    identifiers: [["veeam_365", id]],
    disabled_by: null,
    ...extra,
  };
}

function entity(entityId, deviceId, originalName = null, extra = {}) {
  return {
    entity_id: entityId,
    device_id: deviceId,
    platform: "veeam_365",
    name: null,
    original_name: originalName,
    entity_category: null,
    disabled_by: null,
    hidden_by: null,
    ...extra,
  };
}

/** A registry set covering every device model the integration creates. */
function registries() {
  return {
    devices: [
      device("job-1", "Exchange Online", "Backup Job"),
      device("job-2", "SharePoint", "Backup Job"),
      device("copy-1", "Exchange Online Copy", "Backup Copy Job"),
      device("repo-1", "Default Backup Repository", "Backup Repository"),
      device("server-1", "Veeam Server", "Backup for Microsoft 365"),
      device("license-1", "Veeam License", "License"),
    ],
    entities: [
      entity("sensor.exchange_online_last_status", "job-1", "Last Status"),
      entity("sensor.exchange_online_last_run", "job-1", "Last Run"),
      entity("sensor.exchange_online_next_run", "job-1", "Next Run"),
      entity("sensor.exchange_online_backup_type", "job-1", "Backup Type", {
        entity_category: "diagnostic",
      }),
      entity("button.exchange_online_start", "job-1", "Start", { entity_category: "config" }),
      entity("sensor.sharepoint_last_status", "job-2", "Last Status"),
      entity("sensor.exchange_online_copy_last_status", "copy-1", "Last Status"),
      entity("binary_sensor.default_backup_repository_online", "repo-1", "Online"),
      entity("sensor.default_backup_repository_used_space", "repo-1", "Used Space"),
      entity("binary_sensor.default_backup_repository_accessible", "repo-1", "Accessible"),
      entity("button.default_backup_repository_rescan", "repo-1", "Synchronize Cache", {
        entity_category: "config",
      }),
      entity("binary_sensor.veeam_server_connected", "server-1", "Connected"),
      entity("sensor.veeam_server_version", "server-1", "Product Version", {
        entity_category: "diagnostic",
      }),
      entity("sensor.veeam_license_status", "license-1", "Status"),
      entity("sensor.veeam_license_expiration", "license-1", "Expiration Date"),
      entity("sensor.veeam_license_used_number", "license-1", "Used Licenses"),
      entity("sensor.veeam_license_total_number", "license-1", "Total Licenses"),
    ],
  };
}

function headings(sections) {
  return sections.flatMap((s) => s.cards.filter((c) => c.type === "heading").map((c) => c.heading));
}

function entityCards(sections) {
  return sections.flatMap((s) => s.cards.filter((c) => c.entity));
}

function entityIdsIn(sections) {
  return entityCards(sections).map((c) => c.entity);
}

function sectionByHeading(sections, title) {
  return sections.find((s) => s.cards.some((c) => c.type === "heading" && c.heading === title));
}

function markdownIn(sections) {
  return sections.flatMap((s) =>
    s.cards.filter((c) => c.type === "markdown").map((c) => c.content),
  );
}

// ---------------------------------------------------------------------------------------------
// Views are named
// ---------------------------------------------------------------------------------------------

test("a generated view names itself", () => {
  // Home Assistant applies the generated config over the view's own keys, so a view strategy
  // that returns no title renders as "Unnamed view"
  for (const group of ["overview", "jobs", "repositories", "infrastructure"]) {
    const view = buildView(group, registries(), {});
    assert.ok(view.title, `${group} should have a title`);
    assert.ok(view.icon, `${group} should have an icon`);
    assert.ok(view.path, `${group} should have a path`);
  }
});

test("the title, icon and path can be set in the strategy config", () => {
  // Renaming a strategy view in the visual editor drops the strategy, so the name has to be
  // settable here
  const view = buildView("jobs", registries(), {
    title: "Backups",
    icon: "mdi:shield",
    path: "veeam-backups",
  });

  assert.equal(view.title, "Backups");
  assert.equal(view.icon, "mdi:shield");
  assert.equal(view.path, "veeam-backups");
});

test("a dashboard keeps its per-view names even when a title is configured", () => {
  const dashboard = buildDashboard(registries(), { title: "Backups" });

  assert.deepEqual(
    dashboard.views.map((v) => v.title),
    ["Overview", "Jobs", "Repositories", "Infrastructure"],
  );
});

test("builds a view per group", () => {
  const dashboard = buildDashboard(registries(), {});

  assert.deepEqual(
    dashboard.views.map((v) => v.path),
    ["overview", "jobs", "repositories", "infrastructure"],
  );
  for (const view of dashboard.views) {
    assert.equal(view.type, "sections", `${view.path} should be a sections view`);
    assert.ok(view.sections.length, `${view.path} should not be empty`);
  }
});

test("the column count is configurable and applied", () => {
  const view = buildView("jobs", registries(), { columns: 2 });

  assert.equal(view.max_columns, 2);
  assert.equal(buildView("jobs", registries(), {}).max_columns, 3);
});

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

test("the overview shows one tile per device", () => {
  const jobs = sectionByHeading(buildSections("overview", registries(), {}), "Backup jobs");
  const tiles = jobs.cards.filter((c) => c.entity);

  assert.equal(tiles.length, 2, "two jobs, two tiles — not one per entity");
});

test("no two overview tiles carry the same label", () => {
  // Several tiles from one device all named after the device is what makes this unreadable
  const cards = entityCards(buildSections("overview", registries(), {}));
  const names = cards.map((c) => c.name);

  assert.equal(new Set(names).size, names.length, `duplicate labels in ${JSON.stringify(names)}`);
});

test("the overview leads a job with its Last Status sensor", () => {
  const jobs = sectionByHeading(buildSections("overview", registries(), {}), "Backup jobs");
  const ids = jobs.cards.filter((c) => c.entity).map((c) => c.entity);

  assert.deepEqual(ids, ["sensor.exchange_online_last_status", "sensor.sharepoint_last_status"]);
});

test("copy jobs get their own section rather than mixing in with backup jobs", () => {
  const titles = headings(buildSections("overview", registries(), {}));

  assert.ok(titles.includes("Backup jobs"));
  assert.ok(titles.includes("Backup copy jobs"), `got ${JSON.stringify(titles)}`);
});

test("the overview leads a repository with its Online sensor", () => {
  const repos = sectionByHeading(buildSections("overview", registries(), {}), "Repositories");

  assert.ok(
    repos.cards.filter((c) => c.entity).every((c) => c.entity.endsWith("_online")),
    "reachability is what matters at a glance",
  );
});

test("section headings carry an icon", () => {
  const sections = buildSections("overview", registries(), {});
  const headingCards = sections.flatMap((s) => s.cards.filter((c) => c.type === "heading"));

  assert.ok(headingCards.length);
  assert.ok(
    headingCards.every((c) => c.icon),
    "a bare heading row looks unfinished",
  );
});

test("buttons never reach the overview", () => {
  const ids = entityIdsIn(buildSections("overview", registries(), {}));

  assert.ok(!ids.some((id) => id.startsWith("button.")));
});

// ---------------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------------

test("server and license state become badges", () => {
  const view = buildView("overview", registries(), {});
  const entities = view.badges.map((b) => b.entity);

  assert.ok(entities.includes("binary_sensor.veeam_server_connected"));
  assert.ok(entities.includes("sensor.veeam_license_status"));
  assert.ok(view.badges.every((b) => b.type === "entity"));
});

test("badged models do not also take a section on the overview", () => {
  const titles = headings(buildSections("overview", registries(), {}));

  assert.ok(!titles.includes("Servers"), `got ${JSON.stringify(titles)}`);
  assert.ok(!titles.includes("Licensing"));
});

test("with badges off nothing is lost — they come back as sections", () => {
  const view = buildView("overview", registries(), { badges: false });
  const titles = headings(view.sections);

  assert.equal(view.badges, undefined);
  assert.ok(titles.includes("Servers"), `got ${JSON.stringify(titles)}`);
  assert.ok(titles.includes("Licensing"));
});

test("badges are named for the entity, not the long device name", () => {
  const view = buildView("overview", registries(), {});
  const license = view.badges.find((b) => b.entity === "sensor.veeam_license_status");

  assert.equal(license.name, "Status");
});

// ---------------------------------------------------------------------------------------------
// Live summary
// ---------------------------------------------------------------------------------------------

test("the overview opens with a live summary", () => {
  const sections = buildSections("overview", registries(), {});
  const content = markdownIn(sections)[0];

  assert.ok(content, "expected a markdown summary");
  assert.match(content, /sensor\.exchange_online_last_status/, "counts have to name the entities");
  assert.match(content, /failed/);
});

test("the summary is a template, so it does not go stale", () => {
  // Strategies run once per page load; anything state-dependent baked into the config would be
  // wrong minutes later
  const content = markdownIn(buildSections("overview", registries(), {}))[0];

  assert.match(content, /\{%\s*set/, "counting belongs in a template, not in the generator");
  assert.match(content, /map\('states'\)/);
});

test("the summary spans the full width", () => {
  const sections = buildSections("overview", registries(), { columns: 3 });

  assert.equal(sections[0].column_span, 3);
});

test("copy jobs are counted in the headline too", () => {
  const content = markdownIn(buildSections("overview", registries(), {}))[0];

  assert.match(content, /sensor\.exchange_online_copy_last_status/);
});

test("license usage is summarised, since VB365 licenses per user", () => {
  const content = markdownIn(buildSections("overview", registries(), {}))[0];

  assert.match(content, /sensor\.veeam_license_used_number/);
  assert.match(content, /sensor\.veeam_license_total_number/);
});

test("the license threshold reaches the summary", () => {
  const content = markdownIn(buildSections("overview", registries(), { license_warn_at: 75 }))[0];

  assert.match(content, /75/);
});

test("a zero license total is not reported as fully used", () => {
  // An unlicensed or still-loading server reports zero, and dividing by it would read as 100%
  const content = markdownIn(buildSections("overview", registries(), {}))[0];

  assert.match(content, /total > 0/);
});

test("the summary counts the same entity the tiles show", () => {
  const sections = buildSections("overview", registries(), {});
  const content = markdownIn(sections)[0];
  const tiles = sectionByHeading(sections, "Backup jobs")
    .cards.filter((c) => c.entity)
    .map((c) => c.entity);

  for (const id of tiles) {
    assert.ok(content.includes(id), `${id} is on a tile but missing from the headline`);
  }
});

test("a running job is counted as running, not as a missing result", () => {
  const content = markdownIn(buildSections("overview", registries(), {}))[0];

  assert.match(content, /'running'/);
});

test("the summary can be turned off", () => {
  const sections = buildSections("overview", registries(), { summary: false });

  assert.equal(markdownIn(sections).length, 0);
});

test("no summary is generated for a system with neither jobs nor licensing", () => {
  const data = {
    devices: [device("repo-1", "Default Backup Repository", "Backup Repository")],
    entities: [entity("binary_sensor.default_backup_repository_online", "repo-1", "Online")],
  };

  assert.equal(markdownIn(buildSections("overview", data, {})).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Device sections
// ---------------------------------------------------------------------------------------------

test("each job becomes its own section", () => {
  assert.deepEqual(headings(buildSections("jobs", registries(), {})), [
    "Exchange Online",
    "SharePoint",
    "Exchange Online Copy",
  ]);
});

test("tiles inside a device section use the entity's short name", () => {
  const section = sectionByHeading(buildSections("jobs", registries(), {}), "Exchange Online");
  const names = section.cards.filter((c) => c.entity).map((c) => c.name);

  assert.deepEqual(names, ["Last Status", "Last Run", "Next Run", "Start"]);
});

test("a renamed entity keeps the name the user gave it", () => {
  const data = registries();
  data.entities[0].name = "Current state";

  const section = sectionByHeading(buildSections("jobs", data, {}), "Exchange Online");

  assert.ok(section.cards.some((c) => c.name === "Current state"));
});

test("an entity with no registry name falls back to its object id", () => {
  const data = {
    devices: [device("job-1", "Exchange Online", "Backup Job")],
    entities: [entity("sensor.exchange_online_last_status", "job-1", null)],
  };

  const section = buildSections("jobs", data, {})[0];

  assert.equal(section.cards.find((c) => c.entity).name, "Last Status");
});

test("states come before buttons, and diagnostics last", () => {
  const section = sectionByHeading(
    buildSections("jobs", registries(), { include_diagnostics: true }),
    "Exchange Online",
  );
  const ids = section.cards.filter((c) => c.entity).map((c) => c.entity);

  assert.ok(
    ids.indexOf("sensor.exchange_online_last_status") < ids.indexOf("button.exchange_online_start"),
    "a state should lead the card list, not a button",
  );
  assert.ok(
    ids.indexOf("button.exchange_online_start") < ids.indexOf("sensor.exchange_online_backup_type"),
    "diagnostics belong last",
  );
});

test("Last Status leads a job section", () => {
  const section = sectionByHeading(buildSections("jobs", registries(), {}), "Exchange Online");
  const ids = section.cards.filter((c) => c.entity).map((c) => c.entity);

  assert.equal(ids[0], "sensor.exchange_online_last_status");
});

test("button tiles hide their state", () => {
  // A button's state is the time it was last pressed, or nothing at all
  const section = sectionByHeading(buildSections("jobs", registries(), {}), "Exchange Online");
  const button = section.cards.find((c) => c.entity === "button.exchange_online_start");

  assert.equal(button.hide_state, true);
});

test("repository buttons appear on the repository device", () => {
  const section = sectionByHeading(
    buildSections("repositories", registries(), {}),
    "Default Backup Repository",
  );

  assert.ok(section.cards.some((c) => c.entity === "button.default_backup_repository_rescan"));
});

test("infrastructure covers the server and the license", () => {
  assert.deepEqual(headings(buildSections("infrastructure", registries(), {})), [
    "Veeam Server",
    "Veeam License",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------------------------

test("diagnostic entities are left out by default", () => {
  assert.ok(
    !entityIdsIn(buildSections("jobs", registries(), {})).includes(
      "sensor.exchange_online_backup_type",
    ),
  );
});

test("diagnostic entities can be opted into", () => {
  const sections = buildSections("jobs", registries(), { include_diagnostics: true });

  assert.ok(entityIdsIn(sections).includes("sensor.exchange_online_backup_type"));
});

test("config entities such as job buttons are included by default", () => {
  assert.ok(
    entityIdsIn(buildSections("jobs", registries(), {})).includes("button.exchange_online_start"),
  );
});

test("config entities can be excluded", () => {
  const sections = buildSections("jobs", registries(), { include_config: false });

  assert.ok(!entityIdsIn(sections).includes("button.exchange_online_start"));
});

test("entities from other integrations are ignored", () => {
  const data = registries();
  data.devices.push(device("other-1", "Some Light", "Bulb"));
  data.entities.push(entity("light.some_light", "other-1", "Light", { platform: "hue" }));

  const everything = buildDashboard(data, {}).views.flatMap((v) => entityIdsIn(v.sections));

  assert.ok(!everything.includes("light.some_light"));
});

test("entities from the Backup & Replication integration are ignored", () => {
  // Someone can run both integrations; each dashboard should build from its own
  const data = registries();
  data.devices.push(device("vbr-job", "Nightly VMs", "Backup Job"));
  data.entities.push(
    entity("sensor.nightly_vms_last_result", "vbr-job", "Last Result", { platform: "veeam_br" }),
  );

  const everything = buildDashboard(data, {}).views.flatMap((v) => entityIdsIn(v.sections));

  assert.ok(!everything.includes("sensor.nightly_vms_last_result"));
});

test("disabled and hidden entities are skipped", () => {
  const data = registries();
  data.entities.push(
    entity("sensor.exchange_online_disabled", "job-1", "Disabled", { disabled_by: "user" }),
    entity("sensor.exchange_online_hidden", "job-1", "Hidden", { hidden_by: "user" }),
  );

  const ids = entityIdsIn(buildSections("jobs", data, {}));

  assert.ok(!ids.includes("sensor.exchange_online_disabled"));
  assert.ok(
    !ids.includes("sensor.exchange_online_hidden"),
    "hiding something should keep it hidden",
  );
});

test("hidden entities can be opted into, disabled ones never", () => {
  const data = registries();
  data.entities.push(
    entity("sensor.exchange_online_disabled", "job-1", "Disabled", { disabled_by: "user" }),
    entity("sensor.exchange_online_hidden", "job-1", "Hidden", { hidden_by: "user" }),
  );

  const ids = entityIdsIn(buildSections("jobs", data, { include_hidden: true }));

  assert.ok(ids.includes("sensor.exchange_online_hidden"));
  assert.ok(
    !ids.includes("sensor.exchange_online_disabled"),
    "a disabled entity has no state, so a tile for it would be broken",
  );
});

test("a disabled device is skipped even if its entities survive", () => {
  const data = registries();
  data.devices[0].disabled_by = "user";

  assert.deepEqual(headings(buildSections("jobs", data, {})), [
    "SharePoint",
    "Exchange Online Copy",
  ]);
});

test("devices with no usable entities produce no section", () => {
  const data = registries();
  data.devices.push(device("job-3", "Ghost Job", "Backup Job"));

  assert.deepEqual(headings(buildSections("jobs", data, {})), [
    "Exchange Online",
    "SharePoint",
    "Exchange Online Copy",
  ]);
});

test("a user-renamed device uses the new name", () => {
  const data = registries();
  data.devices[0].name_by_user = "Renamed Job";

  assert.ok(headings(buildSections("jobs", data, {})).includes("Renamed Job"));
});

// ---------------------------------------------------------------------------------------------
// Multiple servers
// ---------------------------------------------------------------------------------------------

test("with one server, section titles are not suffixed", () => {
  assert.deepEqual(headings(buildSections("jobs", registries(), {})), [
    "Exchange Online",
    "SharePoint",
    "Exchange Online Copy",
  ]);
});

test("with two servers, sections name which server they belong to", () => {
  const data = registries();
  data.devices.push(
    device("server-2", "Veeam Server 2", "Backup for Microsoft 365", ENTRY_2),
    device("job-9", "Exchange Online", "Backup Job", ENTRY_2),
  );
  data.entities.push(
    entity("binary_sensor.veeam_server_2_connected", "server-2", "Connected"),
    entity("sensor.exchange_online_2_last_status", "job-9", "Last Status"),
  );

  const titles = headings(buildSections("jobs", data, {}));

  assert.ok(
    titles.includes("Exchange Online — Veeam Server") &&
      titles.includes("Exchange Online — Veeam Server 2"),
    `identically named jobs should be distinguishable, got ${JSON.stringify(titles)}`,
  );
});

test("with two servers, badges say which server they describe", () => {
  const data = registries();
  data.devices.push(device("server-2", "Veeam Server 2", "Backup for Microsoft 365", ENTRY_2));
  data.entities.push(entity("binary_sensor.veeam_server_2_connected", "server-2", "Connected"));

  const view = buildView("overview", data, {});
  const names = view.badges.map((b) => b.name);

  assert.ok(names.includes("Connected (Veeam Server)"), `got ${JSON.stringify(names)}`);
  assert.ok(names.includes("Connected (Veeam Server 2)"));
});

// ---------------------------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------------------------

test("an empty system explains itself instead of rendering blank", () => {
  const dashboard = buildDashboard({ devices: [], entities: [] }, {});

  assert.equal(dashboard.views.length, 1);
  const content = dashboard.views[0].cards[0].content;
  assert.match(content, /No Veeam entities found/);
  assert.match(content, /ha-veeam-365/, "should point at the integration that feeds it");
});

test("a system with only other integrations also gets the empty view", () => {
  const data = {
    devices: [device("x", "Light", "Bulb")],
    entities: [entity("light.x", "x", "Light", { platform: "hue" })],
  };

  assert.match(buildDashboard(data, {}).views[0].cards[0].content, /No Veeam entities found/);
});

test("views with nothing in them are dropped", () => {
  const data = {
    devices: [device("job-1", "Only Job", "Backup Job")],
    entities: [entity("sensor.only_job_last_status", "job-1", "Last Status")],
  };

  assert.deepEqual(
    buildDashboard(data, {}).views.map((v) => v.path),
    ["overview", "jobs"],
    "no repositories or infrastructure means no empty tabs",
  );
});

test("an unknown group falls back to the overview", () => {
  const sections = buildSections("nonsense", registries(), {});

  assert.equal(headings(sections)[0], "Backup jobs");
});

test("every generated card names a card type", () => {
  const dashboard = buildDashboard(registries(), {});

  for (const view of dashboard.views) {
    for (const section of view.sections) {
      assert.equal(section.type, "grid");
      for (const card of section.cards) {
        assert.ok(card.type, `card without a type: ${JSON.stringify(card)}`);
      }
    }
  }
});

test("nothing generated depends on the current state of an entity", () => {
  // The strategy runs once per page load. A colour or an order derived from live states would
  // be a stale snapshot for the rest of the session.
  const dashboard = buildDashboard(registries(), {});
  const json = JSON.stringify(dashboard);

  for (const key of ['"color"', '"state_color"']) {
    assert.ok(!json.includes(key), `${key} would freeze a live state into the config`);
  }
});
