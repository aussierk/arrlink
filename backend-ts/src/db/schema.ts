import { sql } from 'drizzle-orm'
import {
  check,
  index,
  int,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// Ported 1:1 from state.py's schema (SCHEMA_VERSION = 1). Every CHECK, FK
// ON DELETE action, and index below must match exactly -- linker.ts relies
// on the cascade ordering and NULL-uniqueness semantics.

export const apps = sqliteTable(
  'apps',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    url: text('url').notNull(),
    apiKey: text('api_key').notNull(),
    enabled: int('enabled').notNull().default(1),
    pollIntervalS: int('poll_interval_s').notNull().default(30),
    lastPollAt: real('last_poll_at'),
    lastError: text('last_error'),
    itemCount: int('item_count').notNull().default(0),
    createdAt: real('created_at')
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    typeCheck: check('apps_type_check', sql`${t.type} IN ('radarr', 'sonarr')`),
  }),
)

export const tags = sqliteTable(
  'tags',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    appId: int('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    count: int('count').notNull().default(0),
    importedAt: real('imported_at').notNull(),
    category: text('category'),
  },
  (t) => ({
    appIdLabelUnique: uniqueIndex('tags_app_id_label_unique').on(t.appId, t.label),
    categoryCheck: check(
      'tags_category_check',
      sql`${t.category} IS NULL OR ${t.category} IN ('genre','certification','collection','quality','language','audio_language','user','custom')`,
    ),
  }),
)

export const rules = sqliteTable(
  'rules',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    appScope: int('app_scope').references(() => apps.id, { onDelete: 'set null' }),
    appTypeScope: text('app_type_scope'),
    conditionsJson: text('conditions_json').notNull().default('[]'),
    dirTemplate: text('dir_template').notNull(),
    filenameTemplate: text('filename_template'),
    // "source" (default): the item's own source folder name is always
    // appended under dirTemplate automatically. "custom": that append is
    // skipped, and dirTemplate alone must resolve the full destination
    // folder name (the pre-9b72b2d behavior).
    dirNamingMode: text('dir_naming_mode').notNull().default('source'),
    enabled: int('enabled').notNull().default(1),
    unlinkOnMismatch: int('unlink_on_mismatch').notNull().default(1),
    priority: int('priority').notNull().default(100),
    createdAt: real('created_at')
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    dirNamingModeCheck: check(
      'rules_dir_naming_mode_check',
      sql`${t.dirNamingMode} IN ('source', 'custom')`,
    ),
  }),
)

export const appItems = sqliteTable(
  'app_items',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    appId: int('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    itemId: int('item_id').notNull(),
    title: text('title').notNull(),
    year: int('year'),
    tagsJson: text('tags_json').notNull().default('[]'),
    path: text('path').notNull().default(''),
    fileCount: int('file_count').notNull().default(0),
    firstSeen: real('first_seen').notNull(),
    lastSeen: real('last_seen').notNull(),
    missingStrikes: int('missing_strikes').notNull().default(0),
    genresJson: text('genres_json').notNull().default('[]'),
    certification: text('certification'),
    collection: text('collection'),
    qualityProfileId: int('quality_profile_id'),
    qualityProfileName: text('quality_profile_name'),
    originalLanguage: text('original_language'),
    // The downloaded file's own audio track(s), distinct from originalLanguage
    // (the title's production language) -- see arr/types.ts's Item.audioLanguages.
    audioLanguagesJson: text('audio_languages_json').notNull().default('[]'),
    // Radarr only (studio) / Sonarr only (network, seriesType) -- always null
    // on the other app type. See arr/types.ts's Item fields of the same name.
    studio: text('studio'),
    network: text('network'),
    seriesType: text('series_type'),
    // The file(s)' own technical mediaInfo, distinct from qualityProfileName
    // (the configured profile *label*) -- see arr/types.ts's Item.videoCodec etc.
    videoCodecJson: text('video_codec_json').notNull().default('[]'),
    videoDynamicRangeJson: text('video_dynamic_range_json').notNull().default('[]'),
    audioCodecJson: text('audio_codec_json').notNull().default('[]'),
    audioChannelsJson: text('audio_channels_json').notNull().default('[]'),
    // Numeric fields, matchable with the 'range' condition type -- see
    // arr/types.ts's Item.rating/popularity/runtime. popularity is Radarr-only
    // (always null on Sonarr).
    rating: real('rating'),
    popularity: real('popularity'),
    runtimeMinutes: int('runtime_minutes'),
    statsFingerprint: text('stats_fingerprint'),
  },
  (t) => ({
    appIdItemIdUnique: uniqueIndex('app_items_app_id_item_id_unique').on(
      t.appId,
      t.itemId,
    ),
  }),
)

export const appFiles = sqliteTable(
  'app_files',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    itemId: int('item_id')
      .notNull()
      .references(() => appItems.id, { onDelete: 'cascade' }),
    relPath: text('rel_path').notNull(),
    absPath: text('abs_path').notNull(),
    size: int('size'),
    mtime: real('mtime'),
    inode: int('inode'),
    missingStrikes: int('missing_strikes').notNull().default(0),
  },
  (t) => ({
    itemIdRelPathUnique: uniqueIndex('app_files_item_id_rel_path_unique').on(
      t.itemId,
      t.relPath,
    ),
    itemIdx: index('idx_app_files_item').on(t.itemId),
    itemInodeIdx: index('idx_app_files_item_inode').on(t.itemId, t.inode),
  }),
)

export const links = sqliteTable(
  'links',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    ruleId: int('rule_id').references(() => rules.id, { onDelete: 'set null' }),
    appId: int('app_id').references(() => apps.id, { onDelete: 'cascade' }),
    itemId: int('item_id').references(() => appItems.id, { onDelete: 'cascade' }),
    fileId: int('file_id').references(() => appFiles.id, { onDelete: 'cascade' }),
    srcPath: text('src_path').notNull(),
    dstPath: text('dst_path').notNull(),
    inode: int('inode'),
    status: text('status').notNull().default('active'),
    createdAt: real('created_at').notNull(),
    matchKey: text('match_key').notNull().default(''),
    missingStrikes: int('missing_strikes').notNull().default(0),
  },
  (t) => ({
    // NULL never equals NULL in a SQLite unique index, so this does NOT
    // dedupe rows sharing ruleId/itemId/fileId = NULL -- linker.ts relies
    // on that. Do not "fix" it.
    ruleItemFileMatchkeyUnique: uniqueIndex('links_rule_item_file_matchkey_unique').on(
      t.ruleId,
      t.itemId,
      t.fileId,
      t.matchKey,
    ),
    dstIdx: index('idx_links_dst').on(t.dstPath),
    appStatusIdx: index('idx_links_app_status').on(t.appId, t.status),
    fileIdx: index('idx_links_file').on(t.fileId),
    itemIdx: index('idx_links_item').on(t.itemId),
    statusIdx: index('idx_links_status').on(t.status),
  }),
)

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  groupsJson: text('groups_json').notNull().default('[]'),
  refreshToken: text('refresh_token'),
  kind: text('kind').notNull().default('oidc'),
  createdAt: real('created_at').notNull(),
  expiresAt: real('expires_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
})

export const events = sqliteTable(
  'events',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    ts: real('ts').notNull(),
    level: text('level').notNull().default('info'),
    appId: int('app_id'),
    ruleId: int('rule_id'),
    message: text('message').notNull(),
  },
  (t) => ({ tsIdx: index('idx_events_ts').on(t.ts) }),
)

export const oidcLogins = sqliteTable('oidc_logins', {
  state: text('state').primaryKey(),
  verifier: text('verifier').notNull(),
  nonce: text('nonce').notNull(),
  nextPath: text('next_path'),
  createdAt: real('created_at').notNull(),
})

export const tagRepository = sqliteTable('tag_repository', {
  id: int('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull().unique(),
})

export const vocabulary = sqliteTable(
  'vocabulary',
  {
    id: int('id').primaryKey({ autoIncrement: true }),
    category: text('category').notNull(),
    appType: text('app_type').notNull(),
    appId: int('app_id').references(() => apps.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    externalId: text('external_id'),
    source: text('source').notNull(),
    importedAt: real('imported_at').notNull(),
  },
  (t) => ({
    lookupIdx: index('idx_vocabulary_lookup').on(t.category, t.appType, t.appId),
    // idx_vocabulary_unique (COALESCE sentinel for app_id) lives in the raw
    // migration SQL -- Drizzle's schema DSL can't express expression indexes.
    categoryCheck: check(
      'vocabulary_category_check',
      sql`${t.category} IN ('genre','certification','collection','quality','language','audio_language','studio','network','series_type','video_codec','video_dynamic_range','audio_codec','audio_channels')`,
    ),
    appTypeCheck: check(
      'vocabulary_app_type_check',
      sql`${t.appType} IN ('radarr','sonarr')`,
    ),
    sourceCheck: check(
      'vocabulary_source_check',
      sql`${t.source} IN ('tmdb','trash','instance','observed')`,
    ),
  }),
)

export const loginAttempts = sqliteTable('login_attempts', {
  username: text('username').primaryKey(),
  failCount: int('fail_count').notNull().default(0),
  firstFailAt: real('first_fail_at'),
  lastFailAt: real('last_fail_at'),
  lockedUntil: real('locked_until'),
})
