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
 *   group                 Only for the view strategy: overview | organizations | jobs |
 *                         repositories | infrastructure (which covers the backup proxies, the
 *                         servers and licensing). Defaults to overview.
 *   title, icon, path     Name the generated view. A view strategy has to supply these
 *                         itself: Home Assistant applies the generated config over the view's
 *                         own keys, so a title set beside `strategy:` is ignored, and renaming
 *                         a strategy view in the visual editor replaces the strategy with
 *                         static cards. Set them here instead.
 *   summary               Live headline counting failed jobs, organizations not backed up and
 *                         license usage. Default true.
 *   badges                Server and license state as badges along the top of the overview
 *                         instead of tiles. Default true.
 *   columns               Maximum section columns. Default 3.
 *   include_diagnostics   Include diagnostic entities. Default false, since they are mostly
 *                         build numbers and IDs. The few the layout is built around are shown
 *                         either way (see ESSENTIAL_ROLES).
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
  PROXY: "Backup Proxy",
  ORGANIZATION: "Microsoft 365 Organization",
  SERVER: "Backup for Microsoft 365",
  LICENSE: "License",
};

/** Section heading and icon per model, in the order they should appear. */
const MODEL_DISPLAY = [
  // What is being protected comes first, then what protects it
  [MODEL.ORGANIZATION, "Organizations", "mdi:domain"],
  [MODEL.JOB, "Backup jobs", "mdi:backup-restore"],
  [MODEL.COPY_JOB, "Backup copy jobs", "mdi:content-copy"],
  [MODEL.REPOSITORY, "Repositories", "mdi:database"],
  [MODEL.PROXY, "Backup proxies", "mdi:server-network"],
  [MODEL.SERVER, "Servers", "mdi:server"],
  [MODEL.LICENSE, "Licensing", "mdi:certificate"],
];

const MODEL_ICON = new Map(MODEL_DISPLAY.map(([model, , icon]) => [model, icon]));
const MODEL_TITLE = new Map(MODEL_DISPLAY.map(([model, title]) => [model, title]));
const MODEL_ORDER = MODEL_DISPLAY.map(([model]) => model);

/** Models whose state belongs in the overview badges rather than in a section of its own. */
const PLATFORM_MODELS = [MODEL.SERVER, MODEL.LICENSE];

const GROUPS = ["overview", "organizations", "jobs", "repositories", "infrastructure"];

const GROUP_VIEW = {
  overview: { title: "Overview", path: "overview", icon: "mdi:backup-restore" },
  organizations: { title: "Organizations", path: "organizations", icon: "mdi:domain" },
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
 * Prefix the integration puts on every device name ("VB365 Job Daily Mail"). Installs from before
 * it was added keep their unprefixed names until the integration next updates the device.
 */
const DEVICE_PREFIX = /^VB365\s+/i;

/**
 * The kind word the integration puts after the prefix, per model. Inside a section headed
 * "Backup jobs", "Job" in every tile name is noise, so it is dropped for these models.
 */
const MODEL_KIND = {
  [MODEL.JOB]: "Job",
  [MODEL.COPY_JOB]: "Copy Job",
  [MODEL.REPOSITORY]: "Repository",
  [MODEL.PROXY]: "Proxy",
  [MODEL.ORGANIZATION]: "Organization",
  [MODEL.SERVER]: "Server",
  [MODEL.LICENSE]: "License",
};

/**
 * The entities the layout looks for by meaning.
 *
 * An entity is identified, in order of trust, by:
 *   keys  its translation key — set by the integration and stable across renames and across
 *         old and new installs, once the integration has been updated
 *   uid   a suffix of its unique ID — the same in every version of the integration
 *   eid   a suffix of its entity ID, ignoring a trailing "_2" that Home Assistant adds on
 *         collision. Old installs got IDs from the old English names ("_online",
 *         "_used_licenses"); new installs get them from the device name plus the translated
 *         entity name ("vb365_repository_x_cache_in_sync"), so both are listed
 *
 * The first identifier the entity actually carries decides; a later one is only a fallback for
 * registries that do not report the earlier one.
 *
 *   domain  when set, only entities of that domain qualify. The suffixes alone cannot tell an
 *           organization's Sync problem sensor ("_sync") from its Last Sync ("_last_sync"), or
 *           a repository's Maintenance flag from its Start Maintenance button
 *
 * Suffixes are shared between models — a proxy's Online and an old repository's "_online" — so
 * roles are always looked up within one device's entities, and what counts as essential is
 * decided per model (see ESSENTIAL_ROLES).
 */
const ROLE = {
  LAST_STATUS: {
    keys: ["job_last_status", "copy_job_last_status"],
    uid: ["_last_status"],
    eid: ["_last_status"],
  },
  LAST_BACKUP: {
    keys: ["job_last_backup", "copy_job_last_backup", "organization_last_backup"],
    uid: ["_last_backup"],
    eid: ["_last_backup"],
  },
  LAST_RUN: { keys: ["job_last_run", "copy_job_last_run"], uid: ["_last_run"], eid: ["_last_run"] },
  NEXT_RUN: { keys: ["job_next_run"], uid: ["_next_run"], eid: ["_next_run"] },
  ENABLED: {
    keys: ["job_is_enabled", "copy_job_is_enabled"],
    uid: ["_is_enabled"],
    eid: ["_enabled"],
  },

  // A job's or copy job's latest session (API v8). Both kinds share these translation keys
  LAST_SESSION: { keys: ["job_last_session"], uid: ["_last_session"], eid: ["_last_session"] },
  SESSION_DURATION: {
    keys: ["job_last_session_duration"],
    uid: ["_last_session_duration"],
    eid: ["_last_session_duration"],
  },
  SESSION_TRANSFERRED: {
    keys: ["job_last_session_transferred"],
    uid: ["_last_session_transferred"],
    eid: ["_last_session_transferred"],
  },
  SESSION_OBJECTS: {
    keys: ["job_last_session_processed_objects"],
    uid: ["_last_session_processed_objects"],
    eid: ["_last_session_processed_objects"],
  },
  SESSION_RATE: {
    keys: ["job_last_session_processing_rate"],
    uid: ["_last_session_processing_rate"],
    eid: ["_last_session_processing_rate"],
  },
  JOB_START: { keys: ["job_start", "copy_job_start"], uid: ["_start"], eid: ["_start"] },
  JOB_STOP: { keys: ["job_stop", "copy_job_stop"], uid: ["_stop"], eid: ["_stop"] },
  JOB_ENABLE: { keys: ["job_enable", "copy_job_enable"], uid: ["_enable"], eid: ["_enable"] },
  JOB_DISABLE: { keys: ["job_disable", "copy_job_disable"], uid: ["_disable"], eid: ["_disable"] },

  // Reports the repository's Invalid state on API v8; the reachability question
  ACCESSIBLE: { keys: ["repository_accessible"], uid: ["_accessible"], eid: ["_accessible"] },
  // Formerly named "Online", which it never measured. Existing installs keep the "_online" ID
  CACHE_IN_SYNC: {
    keys: ["repository_cache_in_sync"],
    uid: ["_online"],
    eid: ["_cache_in_sync", "_online"],
  },
  OUT_OF_DATE: { keys: ["repository_out_of_date"], uid: ["_out_of_date"], eid: ["_out_of_date"] },
  USED_SPACE: { keys: ["repository_used_space"], uid: ["_used_space"], eid: ["_used_space"] },
  // Repository maintenance sessions (VB365 8.6 and later)
  MAINTENANCE: {
    keys: ["repository_maintenance"],
    uid: ["_maintenance"],
    eid: ["_maintenance"],
    domain: "binary_sensor",
  },
  MAINTENANCE_STATUS: {
    keys: ["repository_maintenance_status"],
    uid: ["_maintenance_status"],
    eid: ["_maintenance_status"],
  },
  RESCAN: { keys: ["repository_rescan"], uid: ["_rescan"], eid: ["_rescan", "_synchronize_cache"] },
  START_MAINTENANCE: {
    keys: ["repository_start_maintenance"],
    uid: ["_start_maintenance"],
    eid: ["_start_maintenance"],
  },
  STOP_MAINTENANCE: {
    keys: ["repository_stop_maintenance"],
    uid: ["_stop_maintenance"],
    eid: ["_stop_maintenance"],
  },

  // Backup proxies. Maintenance mode, usage, version and OS exist on API v8 only
  PROXY_ONLINE: {
    keys: ["proxy_online"],
    uid: ["_online"],
    eid: ["_online"],
    domain: "binary_sensor",
  },
  PROXY_MAINTENANCE_MODE: {
    keys: ["proxy_maintenance_mode"],
    uid: ["_maintenance_mode"],
    eid: ["_maintenance_mode"],
  },
  PROXY_CPU: { keys: ["proxy_cpu_usage"], uid: ["_cpu_usage"], eid: ["_cpu_usage"] },
  PROXY_MEMORY: { keys: ["proxy_memory_usage"], uid: ["_memory_usage"], eid: ["_memory_usage"] },
  PROXY_VERSION: { keys: ["proxy_version"], uid: ["_version"], eid: ["_version"] },
  PROXY_OS: {
    keys: ["proxy_operating_system"],
    uid: ["_operating_system"],
    eid: ["_operating_system"],
  },

  // Microsoft 365 organizations. Last Backup is the shared LAST_BACKUP role
  BACKED_UP: { keys: ["organization_backed_up"], uid: ["_backed_up"], eid: ["_backed_up"] },
  LICENSED_USERS: {
    keys: ["organization_licensed_users"],
    uid: ["_licensed_users"],
    eid: ["_licensed_users"],
  },
  NEW_USERS: { keys: ["organization_new_users"], uid: ["_new_users"], eid: ["_new_users"] },
  PROTECTED_USERS: {
    keys: ["organization_protected_users"],
    uid: ["_protected_users"],
    eid: ["_protected_users"],
  },
  PROTECTED_GROUPS: {
    keys: ["organization_protected_groups"],
    uid: ["_protected_groups"],
    eid: ["_protected_groups"],
  },
  PROTECTED_SITES: {
    keys: ["organization_protected_sites"],
    uid: ["_protected_sites"],
    eid: ["_protected_sites"],
  },
  PROTECTED_TEAMS: {
    keys: ["organization_protected_teams"],
    uid: ["_protected_teams"],
    eid: ["_protected_teams"],
  },
  // Cache sync with Microsoft 365 (API v7 and later): on is a Problem, the last sync failed
  ORG_SYNC: {
    keys: ["organization_sync"],
    uid: ["_sync"],
    eid: ["_sync"],
    domain: "binary_sensor",
  },
  // Idle, Queued or Running (API v8)
  SYNC_STATUS: {
    keys: ["organization_sync_status"],
    uid: ["_sync_status"],
    eid: ["_sync_status"],
  },
  LAST_SYNC: {
    keys: ["organization_last_sync"],
    uid: ["_last_sync"],
    eid: ["_last_sync"],
    domain: "sensor",
  },
  SYNCHRONIZE: {
    keys: ["organization_synchronize"],
    uid: ["_synchronize"],
    eid: ["_synchronize"],
    domain: "button",
  },
  ORG_TYPE: { keys: ["organization_type"], uid: ["_type"], eid: ["_type"] },
  ORG_REGION: { keys: ["organization_region"], uid: ["_region"], eid: ["_region"] },

  CONNECTED: { keys: ["server_connected"], uid: ["_server_connected"], eid: ["_connected"] },
  // Whether every endpoint answered the integration's last poll
  HEALTH_OK: { keys: ["server_health_ok"], uid: ["_server_health_ok"], eid: ["_health_ok"] },
  // The server's own verdict from /v8/Health: on is a Problem
  SERVICE_HEALTH: {
    keys: ["service_health"],
    uid: ["_service_health"],
    eid: ["_service_health"],
  },
  VERSION: { keys: ["server_version"], uid: ["_server_version"], eid: ["_product_version"] },
  LICENSE_STATUS: { keys: ["license_status"], uid: ["_license_status"], eid: ["_status"] },
  LICENSE_EXPIRATION: {
    keys: ["license_expiration"],
    uid: ["_license_expiration"],
    eid: ["_expiration_date"],
  },
  LICENSE_USED: {
    keys: ["license_used_number"],
    uid: ["_license_used_number"],
    eid: ["_used_licenses"],
  },
  LICENSE_TOTAL: {
    keys: ["license_total_number"],
    uid: ["_license_total_number"],
    eid: ["_total_licenses"],
  },
};

/**
 * The one entity that answers "is this thing all right?", per model.
 *
 * The overview shows exactly one tile per device, named for the device — several tiles from one
 * device all carrying the device name is what makes it unreadable. First match wins.
 */
const PRIMARY_ROLES = {
  [MODEL.JOB]: [ROLE.LAST_STATUS, ROLE.LAST_BACKUP],
  [MODEL.COPY_JOB]: [ROLE.LAST_STATUS, ROLE.LAST_BACKUP],
  [MODEL.REPOSITORY]: [ROLE.ACCESSIBLE, ROLE.USED_SPACE],
  [MODEL.PROXY]: [ROLE.PROXY_ONLINE, ROLE.PROXY_MAINTENANCE_MODE],
  // Backed Up is filed as diagnostic, yet whether a tenant has any backup is the question
  [MODEL.ORGANIZATION]: [ROLE.BACKED_UP, ROLE.LAST_BACKUP],
  [MODEL.SERVER]: [ROLE.CONNECTED, ROLE.VERSION],
  [MODEL.LICENSE]: [ROLE.LICENSE_STATUS, ROLE.LICENSE_EXPIRATION],
};

/** Entities promoted to badges, most important first. */
const BADGE_ROLES = {
  [MODEL.SERVER]: [ROLE.CONNECTED],
  [MODEL.LICENSE]: [ROLE.LICENSE_STATUS, ROLE.LICENSE_EXPIRATION],
};

/**
 * Diagnostic entities a device section is built around besides its headline: the license
 * counts behind the usage headline, the server's health, a repository's maintenance status,
 * an organization's new users and the rate in a job's session row.
 */
const EXTRA_ESSENTIAL_ROLES = {
  [MODEL.JOB]: [ROLE.SESSION_RATE],
  [MODEL.COPY_JOB]: [ROLE.SESSION_RATE],
  [MODEL.REPOSITORY]: [ROLE.MAINTENANCE_STATUS],
  [MODEL.ORGANIZATION]: [ROLE.NEW_USERS],
  [MODEL.SERVER]: [ROLE.HEALTH_OK, ROLE.SERVICE_HEALTH],
  [MODEL.LICENSE]: [ROLE.LICENSE_USED, ROLE.LICENSE_TOTAL],
};

/**
 * Entities the layout is built around, per model. The integration files several of them as
 * diagnostic — Connected, Health OK, the license counts, the repository flags, Backed Up —
 * which would otherwise leave the badges, the headline and whole device sections empty with
 * diagnostics off. Per model because suffixes repeat across models: a proxy's "_online" is its
 * headline, an old repository's "_online" is only its cache state.
 */
const ESSENTIAL_ROLES = new Map(
  Object.values(MODEL).map((model) => [
    model,
    [
      ...new Set([
        ...(PRIMARY_ROLES[model] || []),
        ...(BADGE_ROLES[model] || []),
        ...(EXTRA_ESSENTIAL_ROLES[model] || []),
      ]),
    ],
  ]),
);

/** For an entity whose device is unknown: anything essential to any model. */
const ANY_ESSENTIAL_ROLE = [...new Set([...ESSENTIAL_ROLES.values()].flat())];

/**
 * Within a device section, states read best in this order, then buttons in this order.
 *
 * Where suffixes overlap the earlier role wins the rank, so a repository's "_online" cache
 * state ranks before a proxy's Online and an old "_cache_in_sync" before an organization's
 * "_sync" — each device only has one of them, so its own order is unaffected.
 */
const ENTITY_ORDER = [
  ROLE.LAST_STATUS,
  ROLE.LAST_SESSION,
  ROLE.SESSION_DURATION,
  ROLE.SESSION_TRANSFERRED,
  ROLE.SESSION_OBJECTS,
  ROLE.SESSION_RATE,
  ROLE.BACKED_UP,
  ROLE.ACCESSIBLE,
  ROLE.MAINTENANCE,
  ROLE.CACHE_IN_SYNC,
  ROLE.PROXY_ONLINE,
  ROLE.ENABLED,
  ROLE.OUT_OF_DATE,
  ROLE.MAINTENANCE_STATUS,
  ROLE.USED_SPACE,
  ROLE.LAST_BACKUP,
  ROLE.PROTECTED_USERS,
  ROLE.PROTECTED_GROUPS,
  ROLE.PROTECTED_SITES,
  ROLE.PROTECTED_TEAMS,
  ROLE.LICENSED_USERS,
  ROLE.NEW_USERS,
  ROLE.ORG_SYNC,
  ROLE.SYNC_STATUS,
  ROLE.LAST_SYNC,
  ROLE.LAST_RUN,
  ROLE.NEXT_RUN,
  ROLE.PROXY_MAINTENANCE_MODE,
  ROLE.PROXY_CPU,
  ROLE.PROXY_MEMORY,
  ROLE.CONNECTED,
  ROLE.HEALTH_OK,
  ROLE.SERVICE_HEALTH,
  ROLE.LICENSE_STATUS,
  ROLE.LICENSE_EXPIRATION,
  ROLE.LICENSE_USED,
  ROLE.LICENSE_TOTAL,
  ROLE.VERSION,
  ROLE.PROXY_VERSION,
  ROLE.PROXY_OS,
  ROLE.ORG_TYPE,
  ROLE.ORG_REGION,
  // Buttons
  ROLE.JOB_START,
  ROLE.JOB_STOP,
  ROLE.JOB_ENABLE,
  ROLE.JOB_DISABLE,
  ROLE.RESCAN,
  ROLE.START_MAINTENANCE,
  ROLE.STOP_MAINTENANCE,
  ROLE.SYNCHRONIZE,
];

/**
 * Figures that belong together, shown as one compact row rather than a tile each: a job's
 * latest session, and what an organization protects. `name` is the short label inside the row,
 * whose title already says the rest; a name the user gave the entity still wins.
 */
const GLANCE_GROUPS = [
  {
    title: "Last session",
    members: [
      [ROLE.SESSION_DURATION, "Duration"],
      [ROLE.SESSION_TRANSFERRED, "Transferred"],
      [ROLE.SESSION_OBJECTS, "Objects"],
      [ROLE.SESSION_RATE, "Rate"],
    ],
  },
  {
    title: "Protected",
    members: [
      [ROLE.PROTECTED_USERS, "Users"],
      [ROLE.PROTECTED_GROUPS, "Groups"],
      [ROLE.PROTECTED_SITES, "Sites"],
      [ROLE.PROTECTED_TEAMS, "Teams"],
    ],
  },
];

function options(config) {
  return { ...DEFAULTS, ...(config || {}) };
}

function deviceName(device) {
  return device.name_by_user || device.name || "Unnamed";
}

/**
 * The device name as a title: "VB365 Job Daily Mail" reads "Daily Mail" under Backup jobs.
 *
 * The "VB365" prefix is dropped always — it only exists to keep entity IDs apart from the
 * Backup & Replication integration. The kind word is dropped for jobs, copy jobs and
 * repositories (their sections and icons already say what they are), and for servers and
 * licenses only when `dropKind` is set: in the Infrastructure view "Server host" and
 * "License host" are only told apart by it. A name the user gave the device is theirs and
 * shown as-is; old installs' unprefixed names pass through unchanged.
 */
function displayName(device, { dropKind = !PLATFORM_MODELS.includes(device.model) } = {}) {
  if (device.name_by_user) return device.name_by_user;

  const name = device.name || "";
  if (!DEVICE_PREFIX.test(name)) return name || "Unnamed";

  const rest = name.replace(DEVICE_PREFIX, "").trim();
  const kind = MODEL_KIND[device.model];
  if (dropKind && kind) {
    const withoutKind = rest.replace(new RegExp(`^${kind}\\s+`, "i"), "").trim();
    if (withoutKind && withoutKind !== rest) return withoutKind;
  }
  return rest || name;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function byName(a, b) {
  return displayName(a).localeCompare(displayName(b), undefined, { numeric: true });
}

/** Entity ID without its domain and without the "_2" Home Assistant adds on collision. */
function objectId(entity) {
  return (entity.entity_id || "").split(".").slice(1).join(".").replace(/_\d+$/, "");
}

/** Whether the entity plays this role. See ROLE for the order identifiers are trusted in. */
function hasRole(entity, role) {
  if (role.domain && domainOf(entity) !== role.domain) return false;
  if (entity.translation_key) return role.keys.includes(entity.translation_key);
  if (entity.unique_id) return role.uid.some((suffix) => entity.unique_id.endsWith(suffix));
  const id = objectId(entity);
  return role.eid.some((suffix) => id.endsWith(suffix));
}

function domainOf(entity) {
  return (entity.entity_id || "").split(".")[0];
}

/** Whether the layout needs this entity even though it is filed as diagnostic. */
function isEssential(entity, model) {
  const roles = model === undefined ? ANY_ESSENTIAL_ROLE : ESSENTIAL_ROLES.get(model) || [];
  return roles.some((role) => hasRole(entity, role));
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

  // No registry name: derive one from the object id, minus the device slug it starts with. The
  // ID may predate the device's current name, so the unprefixed forms are tried too
  const id = objectId(entity);
  const slugs = [deviceName(device), displayName(device, { dropKind: false }), displayName(device)]
    .map(slugify)
    .filter(Boolean);
  const slug = slugs.find((candidate) => id.startsWith(`${candidate}_`));
  const trimmed = slug ? id.slice(slug.length + 1) : id;

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
  const index = ENTITY_ORDER.findIndex((role) => hasRole(entity, role));
  return index === -1 ? ENTITY_ORDER.length : index;
}

/**
 * Entities belonging to this integration, keyed by device.
 *
 * Filtering on the registry rather than on entity_id patterns means renamed entities are
 * still found, and entities the user disabled or hid stay out of the way.
 */
function entitiesByDevice(entities, devices, opts) {
  const byDevice = new Map();
  const modelOf = new Map(devices.map((device) => [device.id, device.model]));

  for (const entity of entities) {
    if (entity.platform !== INTEGRATION) continue;
    if (entity.disabled_by) continue;
    if (entity.hidden_by && !opts.include_hidden) continue;
    if (
      entity.entity_category === "diagnostic" &&
      !opts.include_diagnostics &&
      !isEssential(entity, modelOf.get(entity.device_id))
    ) {
      continue;
    }
    if (entity.entity_category === "config" && !opts.include_config) continue;
    if (!entity.device_id) continue;

    const list = byDevice.get(entity.device_id) || [];
    list.push(entity);
    byDevice.set(entity.device_id, list);
  }

  // States first, in reading order, then buttons, then diagnostics — so a card leads with what
  // someone opened the dashboard to see and the controls sit together at the end
  for (const [deviceId, list] of byDevice) {
    const model = modelOf.get(deviceId);
    list.sort((a, b) => {
      const category = (entity) => {
        if (entity.entity_category === "diagnostic" && !isEssential(entity, model)) return 2;
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
      // "VB365 Server veeam.example.com" labels as the host; an old "Veeam Server" as itself
      labels.set(entryId, displayName(device, { dropKind: true }));
    }
  }
  return labels;
}

function entryOf(device) {
  return (device.config_entries || [])[0];
}

/**
 * The server label a title needs, if any: only with several servers, and never on the server's
 * own device, whose name already is the label.
 */
function titleLabel(device, labels, multiServer) {
  if (!multiServer || device.model === MODEL.SERVER) return null;
  return labels.get(entryOf(device)) || null;
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

/** A compact row of figures, for values that read as one line rather than a tile each. */
function glance(title, entities) {
  return { type: "glance", title, entities, grid_options: { columns: "full" } };
}

function findByRoles(entities, roles) {
  for (const role of roles || []) {
    const found = entities.find((entity) => hasRole(entity, role));
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

/**
 * An organization with no backup at all is unprotected however well its jobs do, and a job
 * headline cannot say so: jobs cover some objects of a tenant, never the tenant as such.
 */
function organizationSummary(entityIds) {
  return [
    `{% set orgs = ${jinjaList(entityIds)} %}`,
    "{% set r = orgs | map('states') | list %}",
    "{% set total = orgs | count %}",
    "{% set missing = r | select('eq', 'off') | list | count %}",
    "{% set backed = r | select('eq', 'on') | list | count %}",
    "{% if missing %}**{{ missing }} of {{ total }} organization{{ 's' if total > 1 else '' }}" +
      " not backed up.**" +
      "{% elif backed %}{{ backed }} of {{ total }} organization{{ 's' if total > 1 else '' }}" +
      " backed up." +
      "{% else %}Organization backups are not being reported.{% endif %}",
  ].join("\n");
}

function summarySection(groups, byDevice, opts, columns) {
  // The same entity the tiles use, so the headline can never disagree with what is below it
  const collect = (model, roles) =>
    (groups.get(model) || [])
      .map((device) => findByRoles(byDevice.get(device.id) || [], roles))
      .filter(Boolean)
      .map((entity) => entity.entity_id);

  const jobs = [
    ...collect(MODEL.JOB, PRIMARY_ROLES[MODEL.JOB]),
    ...collect(MODEL.COPY_JOB, PRIMARY_ROLES[MODEL.COPY_JOB]),
  ];

  // Only Backed Up: the template counts on and off, which a Last Backup timestamp is neither
  const organizations = collect(MODEL.ORGANIZATION, [ROLE.BACKED_UP]);

  const licenseEntities = (groups.get(MODEL.LICENSE) || []).flatMap(
    (device) => byDevice.get(device.id) || [],
  );
  const used = findByRoles(licenseEntities, [ROLE.LICENSE_USED]);
  const total = findByRoles(licenseEntities, [ROLE.LICENSE_TOTAL]);

  const parts = [];
  if (jobs.length) parts.push(jobSummary(jobs));
  if (organizations.length) parts.push(organizationSummary(organizations));
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
    const label = titleLabel(device, labels, multiServer);
    const title = label ? `${displayName(device)} — ${label}` : displayName(device);

    return titledSection(title, MODEL_ICON.get(device.model), [
      ...deviceCards(entities, device),
      ...problemNotes(entities),
    ]);
  });
}

/**
 * A tile per entity, in the order entitiesByDevice sorted them — except that the members of a
 * glance group share one row, placed where the first of them would have been.
 */
function deviceCards(entities, device) {
  const cards = [];
  const grouped = new Set();

  for (const entity of entities) {
    if (grouped.has(entity)) continue;
    const name = entityName(entity, device);

    // A button's state is the time it was last pressed, or nothing at all — noise next to a
    // control whose label already says what it does
    if (isButton(entity)) {
      cards.push(tile(entity.entity_id, { name, hide_state: true }));
      continue;
    }

    const group = GLANCE_GROUPS.find((candidate) =>
      candidate.members.some(([role]) => hasRole(entity, role)),
    );
    if (!group) {
      cards.push(tile(entity.entity_id, { name }));
      continue;
    }

    const row = [];
    for (const [role, short] of group.members) {
      const member = entities.find(
        (candidate) => !grouped.has(candidate) && !isButton(candidate) && hasRole(candidate, role),
      );
      if (!member) continue;
      grouped.add(member);
      row.push({ entity: member.entity_id, name: member.name || short });
    }
    cards.push(glance(group.title, row));
  }

  return cards;
}

/**
 * What went wrong, shown only while it is wrong.
 *
 * Health OK, Service Health and an organization's Sync each put the reason for a bad state in
 * an attribute, and a bare "Problem" does not say where to look. The visibility condition is
 * evaluated live, so nothing here is fixed at render time.
 */
function problemNotes(entities) {
  const notes = [];

  const health = findByRoles(entities, [ROLE.HEALTH_OK]);
  if (health && health.entity_id.startsWith("binary_sensor.")) {
    const id = health.entity_id;
    notes.push(
      markdown(
        `{% set failed = state_attr('${id}', 'failed_endpoints') or [] %}` +
          "{% if failed %}**Failing endpoints:** {{ failed | join(', ') }}" +
          "{% else %}The last poll did not complete.{% endif %}",
        { visibility: [{ condition: "state", entity: id, state: "off" }] },
      ),
    );
  }

  const service = findByRoles(entities, [ROLE.SERVICE_HEALTH]);
  if (service) {
    const id = service.entity_id;
    notes.push(
      markdown(
        `{% set problems = state_attr('${id}', 'problems') or [] %}` +
          "**Server health:** {% if problems %}{{ problems | join('; ') }}" +
          "{% else %}the server reports itself unhealthy.{% endif %}",
        { visibility: [{ condition: "state", entity: id, state: "on" }] },
      ),
    );
  }

  const sync = findByRoles(entities, [ROLE.ORG_SYNC]);
  if (sync) {
    const id = sync.entity_id;
    notes.push(
      markdown(
        `{% set error = state_attr('${id}', 'error') %}` +
          "**Last sync failed**{% if error %}: {{ error }}{% else %}.{% endif %}",
        { visibility: [{ condition: "state", entity: id, state: "on" }] },
      ),
    );
  }

  return notes;
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
        findByRoles(entities, PRIMARY_ROLES[model]) || entities.find((entity) => !isButton(entity));
      if (!primary) continue;

      const label = titleLabel(device, labels, multiServer);
      cards.push(
        tile(primary.entity_id, {
          name: label ? `${displayName(device)} (${label})` : displayName(device),
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
      for (const role of BADGE_ROLES[model] || []) {
        const entity = entities.find((candidate) => hasRole(candidate, role));
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
  const byDevice = entitiesByDevice(registries.entities || [], registries.devices || [], opts);
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
    case "organizations":
      return sectionsFor([MODEL.ORGANIZATION]);
    case "jobs":
      return sectionsFor([MODEL.JOB, MODEL.COPY_JOB]);
    case "repositories":
      return sectionsFor([MODEL.REPOSITORY]);
    case "infrastructure":
      return sectionsFor([MODEL.PROXY, MODEL.SERVER, MODEL.LICENSE]);
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
