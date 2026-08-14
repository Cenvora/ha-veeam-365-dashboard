/**
 * Veeam Backup for Microsoft 365 dashboard strategy.
 *
 * Builds a dashboard from whatever the ha-veeam-365 integration has created, so there is
 * nothing to maintain by hand as jobs and repositories come and go.
 *
 * Dashboard:
 *   strategy:
 *     type: custom:veeam-365
 *
 * A single view inside an existing dashboard:
 *   views:
 *     - strategy:
 *         type: custom:veeam-365
 *         group: jobs
 *         title: Backups
 *
 * Options (all optional):
 *   group                 Only for the view strategy: overview | jobs | repositories |
 *                         infrastructure (which covers the servers and licensing). Defaults
 *                         to overview.
 *   title, icon, path     Name the generated view. A view strategy has to supply these
 *                         itself: Home Assistant applies the generated config over the view's
 *                         own keys, so a title set beside `strategy:` is ignored, and renaming
 *                         a strategy view in the visual editor replaces the strategy with
 *                         static cards. Set them here instead.
 *   summary               Live headline counting failed jobs and license usage. Default true.
 *   badges                Server and license state as badges along the top of the overview
 *                         instead of tiles. Default true.
 *   columns               Maximum section columns. Default 3.
 *   include_diagnostics   Include diagnostic entities. Default false, since they are mostly
 *                         build numbers and IDs.
 *   include_config        Include config-category entities. Default true — the job start and
 *                         stop buttons live here.
 *   include_hidden        Include entities the user hid. Default false: hiding something and
 *                         having it reappear is not what anyone means.
 *   license_warn_at       Percentage of licensed users treated as a warning. Default 90.
 */

const INTEGRATION = "veeam_365";

/** Device models set by the integration. */
const MODEL = {
  JOB: "Backup Job",
  COPY_JOB: "Backup Copy Job",
  REPOSITORY: "Backup Repository",
  SERVER: "Backup for Microsoft 365",
  LICENSE: "License",
};

/** Section heading and icon per model, in the order they should appear. */
const MODEL_DISPLAY = [
  [MODEL.JOB, "Backup jobs", "mdi:backup-restore"],
  [MODEL.COPY_JOB, "Backup copy jobs", "mdi:content-copy"],
  [MODEL.REPOSITORY, "Repositories", "mdi:database"],
  [MODEL.SERVER, "Servers", "mdi:server"],
  [MODEL.LICENSE, "Licensing", "mdi:certificate"],
];

const MODEL_ICON = new Map(MODEL_DISPLAY.map(([model, , icon]) => [model, icon]));
const MODEL_TITLE = new Map(MODEL_DISPLAY.map(([model, title]) => [model, title]));
const MODEL_ORDER = MODEL_DISPLAY.map(([model]) => model);

/** Models whose state belongs in the overview badges rather than in a section of its own. */
const PLATFORM_MODELS = [MODEL.SERVER, MODEL.LICENSE];

const GROUPS = ["overview", "jobs", "repositories", "infrastructure"];

const GROUP_VIEW = {
  overview: { title: "Overview", path: "overview", icon: "mdi:backup-restore" },
  jobs: { title: "Jobs", path: "jobs", icon: "mdi:file-tree" },
  repositories: { title: "Repositories", path: "repositories", icon: "mdi:database" },
  infrastructure: { title: "Infrastructure", path: "infrastructure", icon: "mdi:server" },
};

const DEFAULTS = {
  summary: true,
  badges: true,
  columns: 3,
  include_diagnostics: false,
  include_config: true,
  include_hidden: false,
  license_warn_at: 90,
};

/**
 * The one entity that answers "is this thing all right?", per model.
 *
 * The overview shows exactly one tile per device, named for the device — several tiles from one
 * device all carrying the device name is what makes it unreadable. First match wins.
 */
const PRIMARY_SUFFIXES = {
  [MODEL.JOB]: ["_last_status", "_last_backup"],
  [MODEL.COPY_JOB]: ["_last_status", "_last_backup"],
  [MODEL.REPOSITORY]: ["_online", "_used_space", "_accessible"],
  [MODEL.SERVER]: ["_connected", "_version"],
  [MODEL.LICENSE]: ["_status", "_expiration"],
};

/** Entities promoted to badges, most important first. */
const BADGE_SUFFIXES = {
  [MODEL.SERVER]: ["_connected"],
  [MODEL.LICENSE]: ["_status", "_expiration"],
};

/** Within a device section, states read best in this order. */
const ENTITY_ORDER = [
  "_last_status",
  "_online",
  "_accessible",
  "_is_enabled",
  "_enabled",
  "_out_of_date",
  "_used_space",
  "_last_backup",
  "_last_run",
  "_next_run",
];

function options(config) {
  return { ...DEFAULTS, ...(config || {}) };
}

function deviceName(device) {
  return device.name_by_user || device.name || "Unnamed";
}

function byName(a, b) {
  return deviceName(a).localeCompare(deviceName(b), undefined, { numeric: true });
}

/**
 * The entity's own short name — "Last Status", "Next Run", "Start".
 *
 * Inside a section already titled with the device name, the full friendly name repeats it on
 * every tile. The registry keeps the user's override and the original separately, so a rename
 * is still respected.
 */
function entityName(entity, device) {
  const own = entity.name || entity.original_name;
  if (own) return own;

  // No registry name: derive one from the object id, minus the device slug it starts with
  const objectId = (entity.entity_id || "").split(".").slice(1).join(".");
  const slug = deviceName(device).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const trimmed = objectId.startsWith(`${slug}_`) ? objectId.slice(slug.length + 1) : objectId;

  return trimmed
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isButton(entity) {
  return (entity.entity_id || "").startsWith("button.");
}

function orderRank(entity) {
  const index = ENTITY_ORDER.findIndex((suffix) => (entity.entity_id || "").endsWith(suffix));
  return index === -1 ? ENTITY_ORDER.length : index;
}

/**
 * Entities belonging to this integration, keyed by device.
 *
 * Filtering on the registry rather than on entity_id patterns means renamed entities are
 * still found, and entities the user disabled or hid stay out of the way.
 */
function entitiesByDevice(entities, opts) {
  const byDevice = new Map();

  for (const entity of entities) {
    if (entity.platform !== INTEGRATION) continue;
    if (entity.disabled_by) continue;
    if (entity.hidden_by && !opts.include_hidden) continue;
    if (entity.entity_category === "diagnostic" && !opts.include_diagnostics) continue;
    if (entity.entity_category === "config" && !opts.include_config) continue;
    if (!entity.device_id) continue;

    const list = byDevice.get(entity.device_id) || [];
    list.push(entity);
    byDevice.set(entity.device_id, list);
  }

  // States first, in reading order, then buttons, then diagnostics — so a card leads with what
  // someone opened the dashboard to see and the controls sit together at the end
  for (const list of byDevice.values()) {
    list.sort((a, b) => {
      const category = (entity) => {
        if (entity.entity_category === "diagnostic") return 2;
        if (isButton(entity)) return 1;
        return 0;
      };
      const byCategory = category(a) - category(b);
      if (byCategory !== 0) return byCategory;

      const byOrder = orderRank(a) - orderRank(b);
      if (byOrder !== 0) return byOrder;
      return (a.entity_id || "").localeCompare(b.entity_id || "");
    });
  }

  return byDevice;
}

/** Devices of this integration that still have at least one usable entity. */
function devicesWithEntities(devices, byDevice) {
  return devices.filter((device) => !device.disabled_by && byDevice.has(device.id)).sort(byName);
}

function groupByModel(devices) {
  const groups = new Map();
  for (const device of devices) {
    const model = device.model || "Other";
    const list = groups.get(model) || [];
    list.push(device);
    groups.set(model, list);
  }
  return groups;
}

/**
 * Map config entry id -> a label for it.
 *
 * With one server the label is unused; with several, titles are suffixed with the server name
 * so two identically named jobs on different servers can be told apart.
 */
function entryLabels(devices) {
  const labels = new Map();
  for (const device of devices) {
    if (device.model !== MODEL.SERVER) continue;
    for (const entryId of device.config_entries || []) {
      labels.set(entryId, deviceName(device));
    }
  }
  return labels;
}

function entryOf(device) {
  return (device.config_entries || [])[0];
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

function tile(entityId, extra = {}) {
  return { type: "tile", entity: entityId, ...extra };
}

function heading(text, icon, extra = {}) {
  return {
    type: "heading",
    heading: text,
    heading_style: "title",
    ...(icon ? { icon } : {}),
    ...extra,
  };
}

function section(cards, extra = {}) {
  return { type: "grid", cards, ...extra };
}

function titledSection(title, icon, cards, extra = {}) {
  return section([heading(title, icon), ...cards], extra);
}

function markdown(content, extra = {}) {
  return { type: "markdown", content, ...extra };
}

function findBySuffixes(entities, suffixes) {
  for (const suffix of suffixes || []) {
    const found = entities.find((entity) => (entity.entity_id || "").endsWith(suffix));
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Live summary
//
// Generated once per page load, so nothing here may depend on current states — a stale
// snapshot baked into card order or colour is worse than none. The counting is left to a
// template, which Home Assistant re-renders as states change.
// ---------------------------------------------------------------------------------------------

function jinjaList(entityIds) {
  return `[${entityIds.map((id) => `'${id}'`).join(", ")}]`;
}

function jobSummary(entityIds) {
  return [
    `{% set jobs = ${jinjaList(entityIds)} %}`,
    // Lower-cased because the API has shipped both casings for these enums between versions
    "{% set r = jobs | map('states') | map('lower') | list %}",
    "{% set failed = r | select('eq', 'failed') | list | count %}",
    "{% set warned = r | select('eq', 'warning') | list | count %}",
    "{% set ok = r | select('eq', 'success') | list | count %}",
    "{% set running = r | select('eq', 'running') | list | count %}",
    "{% set other = jobs | count - failed - warned - ok - running %}",
    "## {% if failed %}{{ failed }} job{{ 's' if failed > 1 else '' }} failed" +
      "{% elif warned %}{{ warned }} job{{ 's' if warned > 1 else '' }} finished with warnings" +
      "{% elif ok %}All {{ ok }} job{{ 's' if ok > 1 else '' }} succeeded" +
      "{% elif running %}{{ running }} job{{ 's' if running > 1 else '' }} running" +
      "{% else %}No job results yet{% endif %}",
    "{{ ok }} succeeded &nbsp;·&nbsp; {{ warned }} with warnings &nbsp;·&nbsp; " +
      "{{ failed }} failed" +
      "{% if running %} &nbsp;·&nbsp; {{ running }} running{% endif %}" +
      "{% if other %} &nbsp;·&nbsp; {{ other }} with no result{% endif %}",
  ].join("\n");
}

/**
 * VB365 licenses per protected user and picks up new users automatically, so how close a
 * tenant is to its limit is the number worth putting on the front page.
 */
function licenseSummary(usedId, totalId, warnAt) {
  return [
    `{% set used = states('${usedId}') | int(-1) %}`,
    `{% set total = states('${totalId}') | int(-1) %}`,
    "{% if used >= 0 and total > 0 %}",
    "{% set pct = (used / total * 100) | round(0) %}",
    `{% if pct >= ${warnAt} %}**{{ used }}** of {{ total }} licenses used ({{ pct }}%).` +
      "{% else %}{{ used }} of {{ total }} licenses used ({{ pct }}%).{% endif %}",
    "{% else %}License usage is not being reported.{% endif %}",
  ].join("\n");
}

function summarySection(groups, byDevice, opts, columns) {
  // The same entity the tiles use, so the headline can never disagree with what is below it
  const collect = (model, suffixes) =>
    (groups.get(model) || [])
      .map((device) => findBySuffixes(byDevice.get(device.id) || [], suffixes))
      .filter(Boolean)
      .map((entity) => entity.entity_id);

  const jobs = [
    ...collect(MODEL.JOB, PRIMARY_SUFFIXES[MODEL.JOB]),
    ...collect(MODEL.COPY_JOB, PRIMARY_SUFFIXES[MODEL.COPY_JOB]),
  ];

  const licenseEntities = (groups.get(MODEL.LICENSE) || []).flatMap(
    (device) => byDevice.get(device.id) || [],
  );
  const used = findBySuffixes(licenseEntities, ["_license_used_number"]);
  const total = findBySuffixes(licenseEntities, ["_license_total_number"]);

  const parts = [];
  if (jobs.length) parts.push(jobSummary(jobs));
  if (used && total) {
    parts.push(licenseSummary(used.entity_id, total.entity_id, opts.license_warn_at));
  }
  if (!parts.length) return null;

  return section([markdown(parts.join("\n\n"))], { column_span: columns });
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

/** One section per device, listing its entities by their own short names. */
function deviceSections(devices, byDevice, labels, multiServer) {
  return devices.map((device) => {
    const entities = byDevice.get(device.id) || [];
    const label = multiServer ? labels.get(entryOf(device)) : null;
    const title = label ? `${deviceName(device)} — ${label}` : deviceName(device);

    const cards = entities.map((entity) => {
      const name = entityName(entity, device);
      // A button's state is the time it was last pressed, or nothing at all — noise next to a
      // control whose label already says what it does
      if (isButton(entity)) {
        return tile(entity.entity_id, { name, hide_state: true });
      }
      return tile(entity.entity_id, { name });
    });

    return titledSection(title, MODEL_ICON.get(device.model), cards);
  });
}

/** One tile per device, named for the device. */
function overviewSections(groups, byDevice, labels, multiServer, opts, columns) {
  const sections = [];

  const summary = opts.summary ? summarySection(groups, byDevice, opts, columns) : null;
  if (summary) sections.push(summary);

  // With badges on, platform state lives along the top and these models are covered in full on
  // the Infrastructure view; with badges off they need a section here or they are lost
  const skip = opts.badges ? new Set(PLATFORM_MODELS) : new Set();

  for (const model of MODEL_ORDER) {
    if (skip.has(model)) continue;

    const devices = groups.get(model);
    if (!devices || !devices.length) continue;

    const cards = [];
    for (const device of devices) {
      const entities = byDevice.get(device.id) || [];
      const primary =
        findBySuffixes(entities, PRIMARY_SUFFIXES[model]) ||
        entities.find((entity) => !isButton(entity));
      if (!primary) continue;

      const label = multiServer ? labels.get(entryOf(device)) : null;
      cards.push(
        tile(primary.entity_id, {
          name: label ? `${deviceName(device)} (${label})` : deviceName(device),
        }),
      );
    }

    if (cards.length) {
      sections.push(titledSection(MODEL_TITLE.get(model) || model, MODEL_ICON.get(model), cards));
    }
  }

  return sections;
}

/** Server and license state, along the top of the overview. */
function overviewBadges(groups, byDevice, labels, multiServer) {
  const badges = [];

  for (const model of PLATFORM_MODELS) {
    for (const device of groups.get(model) || []) {
      const entities = byDevice.get(device.id) || [];
      for (const suffix of BADGE_SUFFIXES[model] || []) {
        const entity = entities.find((candidate) => candidate.entity_id.endsWith(suffix));
        if (!entity) continue;

        const label = multiServer ? labels.get(entryOf(device)) : null;
        const name = entityName(entity, device);
        badges.push({
          type: "entity",
          entity: entity.entity_id,
          name: label ? `${name} (${label})` : name,
          show_state: true,
          show_name: true,
        });
      }
    }
  }

  return badges;
}

function emptyView(opts) {
  return {
    title: opts.title || "Veeam 365",
    icon: opts.icon || "mdi:backup-restore",
    cards: [
      markdown(
        "### No Veeam entities found\n\n" +
          "This dashboard builds itself from the " +
          "[Veeam Backup for Microsoft 365 integration](https://github.com/Cenvora/ha-veeam-365). " +
          "Add the integration under **Settings → Devices & Services**, then reload this page.\n\n" +
          "If the integration is already set up, its entities may all be disabled or hidden.",
      ),
    ],
  };
}

/** Everything the layout needs, derived once from the registries. */
function analyse(registries, opts) {
  const byDevice = entitiesByDevice(registries.entities || [], opts);
  const devices = devicesWithEntities(registries.devices || [], byDevice);

  return {
    byDevice,
    devices,
    groups: groupByModel(devices),
    labels: entryLabels(devices),
    multiServer: new Set(devices.map(entryOf).filter(Boolean)).size > 1,
  };
}

/** Build the sections for one group. Exported for the view strategy and for tests. */
export function buildSections(group, registries, config) {
  const opts = options(config);
  const columns = opts.columns;
  const { byDevice, devices, groups, labels, multiServer } = analyse(registries, opts);

  if (!devices.length) return null;

  const sectionsFor = (models) =>
    deviceSections(
      models.flatMap((model) => groups.get(model) || []),
      byDevice,
      labels,
      multiServer,
    );

  switch (group) {
    case "jobs":
      return sectionsFor([MODEL.JOB, MODEL.COPY_JOB]);
    case "repositories":
      return sectionsFor([MODEL.REPOSITORY]);
    case "infrastructure":
      return sectionsFor([MODEL.SERVER, MODEL.LICENSE]);
    case "overview":
    default:
      return overviewSections(groups, byDevice, labels, multiServer, opts, columns);
  }
}

/**
 * Build one view. Exported for tests.
 *
 * Titles come from the strategy config rather than the view, because Home Assistant applies a
 * strategy's generated config over the view's own keys.
 */
export function buildView(group, registries, config) {
  const opts = options(config);
  const sections = buildSections(group, registries, config);
  if (!sections || !sections.length) return null;

  const defaults = GROUP_VIEW[group] || GROUP_VIEW.overview;
  const view = {
    title: opts.title || defaults.title,
    path: opts.path || defaults.path,
    icon: opts.icon || defaults.icon,
    type: "sections",
    max_columns: opts.columns,
    dense_section_placement: true,
    sections,
  };

  if (group === "overview" && opts.badges) {
    const { byDevice, groups, labels, multiServer } = analyse(registries, opts);
    const badges = overviewBadges(groups, byDevice, labels, multiServer);
    if (badges.length) view.badges = badges;
  }

  return view;
}

/** Build the whole dashboard. Exported for tests. */
export function buildDashboard(registries, config) {
  const opts = options(config);
  const views = [];

  for (const group of GROUPS) {
    // A view strategy is given one title; a dashboard keeps the per-group defaults
    const viewConfig = { ...(config || {}), title: undefined, path: undefined, icon: undefined };
    const view = buildView(group, registries, viewConfig);
    // Skip a view with nothing in it rather than showing an empty tab
    if (view) views.push(view);
  }

  if (!views.length) return { views: [emptyView(opts)] };

  return { views };
}

async function loadRegistries(hass) {
  const [devices, entities] = await Promise.all([
    hass.callWS({ type: "config/device_registry/list" }),
    hass.callWS({ type: "config/entity_registry/list" }),
  ]);
  return { devices, entities };
}

// customElements.define requires an HTMLElement subclass, but Home Assistant only ever calls
// the static generate(). Resolving the base at runtime keeps the module importable outside a
// browser, which is what makes the build logic testable.
const StrategyBase = typeof HTMLElement === "undefined" ? class {} : HTMLElement;

class Veeam365DashboardStrategy extends StrategyBase {
  static async generate(config, hass) {
    return buildDashboard(await loadRegistries(hass), config);
  }
}

class Veeam365ViewStrategy extends StrategyBase {
  static async generate(config, hass) {
    const group = GROUPS.includes(config?.group) ? config.group : "overview";
    const view = buildView(group, await loadRegistries(hass), config);

    if (!view) {
      const opts = options(config);
      const empty = markdown("No Veeam entities found.");
      return {
        type: "sections",
        title: opts.title || "Veeam 365",
        icon: opts.icon || "mdi:backup-restore",
        sections: [titledSection("Veeam 365", "mdi:backup-restore", [empty])],
      };
    }

    return view;
  }
}

// Registered defensively: a dashboard can be reloaded without a full page refresh, and
// defining an existing element throws.
if (typeof customElements !== "undefined") {
  if (!customElements.get("ll-strategy-dashboard-veeam-365")) {
    customElements.define("ll-strategy-dashboard-veeam-365", Veeam365DashboardStrategy);
  }
  if (!customElements.get("ll-strategy-view-veeam-365")) {
    customElements.define("ll-strategy-view-veeam-365", Veeam365ViewStrategy);
  }
}

console.info("%c VEEAM-365-DASHBOARD %c strategy loaded ", "color:white;background:#00b336", "");
