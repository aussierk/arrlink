CREATE TABLE `app_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`rel_path` text NOT NULL,
	`abs_path` text NOT NULL,
	`size` integer,
	`mtime` real,
	`inode` integer,
	`missing_strikes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `app_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_files_item_id_rel_path_unique` ON `app_files` (`item_id`,`rel_path`);--> statement-breakpoint
CREATE INDEX `idx_app_files_item` ON `app_files` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_app_files_item_inode` ON `app_files` (`item_id`,`inode`);--> statement-breakpoint
CREATE TABLE `app_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`first_seen` real NOT NULL,
	`last_seen` real NOT NULL,
	`missing_strikes` integer DEFAULT 0 NOT NULL,
	`genres_json` text DEFAULT '[]' NOT NULL,
	`certification` text,
	`collection` text,
	`quality_profile_id` integer,
	`quality_profile_name` text,
	`original_language` text,
	`stats_fingerprint` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_items_app_id_item_id_unique` ON `app_items` (`app_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `apps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`api_key` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`poll_interval_s` integer DEFAULT 30 NOT NULL,
	`last_poll_at` real,
	`last_error` text,
	`item_count` integer DEFAULT 0 NOT NULL,
	`created_at` real DEFAULT (strftime('%s','now')) NOT NULL,
	CONSTRAINT "apps_type_check" CHECK("apps"."type" IN ('radarr', 'sonarr'))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` real NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`app_id` integer,
	`rule_id` integer,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_ts` ON `events` (`ts`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` integer,
	`app_id` integer,
	`item_id` integer,
	`file_id` integer,
	`src_path` text NOT NULL,
	`dst_path` text NOT NULL,
	`inode` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` real NOT NULL,
	`match_key` text DEFAULT '' NOT NULL,
	`missing_strikes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `app_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `app_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_rule_item_file_matchkey_unique` ON `links` (`rule_id`,`item_id`,`file_id`,`match_key`);--> statement-breakpoint
CREATE INDEX `idx_links_dst` ON `links` (`dst_path`);--> statement-breakpoint
CREATE INDEX `idx_links_app_status` ON `links` (`app_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_links_file` ON `links` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_links_item` ON `links` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_links_status` ON `links` (`status`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`username` text PRIMARY KEY NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`first_fail_at` real,
	`last_fail_at` real,
	`locked_until` real
);
--> statement-breakpoint
CREATE TABLE `oidc_logins` (
	`state` text PRIMARY KEY NOT NULL,
	`verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`next_path` text,
	`created_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`app_scope` integer,
	`app_type_scope` text,
	`conditions_json` text DEFAULT '[]' NOT NULL,
	`dir_template` text NOT NULL,
	`filename_template` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`unlink_on_mismatch` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` real DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`app_scope`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`groups_json` text DEFAULT '[]' NOT NULL,
	`refresh_token` text,
	`kind` text DEFAULT 'oidc' NOT NULL,
	`created_at` real NOT NULL,
	`expires_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tag_repository` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_repository_label_unique` ON `tag_repository` (`label`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`label` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`imported_at` real NOT NULL,
	`category` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tags_category_check" CHECK("tags"."category" IS NULL OR "tags"."category" IN ('genre','certification','collection','quality','language','user','custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_app_id_label_unique` ON `tags` (`app_id`,`label`);--> statement-breakpoint
CREATE TABLE `vocabulary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`app_type` text NOT NULL,
	`app_id` integer,
	`value` text NOT NULL,
	`external_id` text,
	`source` text NOT NULL,
	`imported_at` real NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vocabulary_category_check" CHECK("vocabulary"."category" IN ('genre','certification','collection','quality','language')),
	CONSTRAINT "vocabulary_app_type_check" CHECK("vocabulary"."app_type" IN ('radarr','sonarr')),
	CONSTRAINT "vocabulary_source_check" CHECK("vocabulary"."source" IN ('tmdb','trash','instance','observed'))
);
--> statement-breakpoint
CREATE INDEX `idx_vocabulary_lookup` ON `vocabulary` (`category`,`app_type`,`app_id`);--> statement-breakpoint
-- A plain UNIQUE(category, app_type, app_id, value) would not dedupe two
-- shared-scope (app_id IS NULL) rows, since SQLite treats NULL as distinct
-- from itself in unique indexes -- COALESCE to a sentinel fixes this.
-- Ported from state.py's idx_vocabulary_unique; Drizzle's schema DSL can't
-- express an expression index, so this is hand-added here.
CREATE UNIQUE INDEX `idx_vocabulary_unique` ON `vocabulary` (`category`,`app_type`,coalesce(`app_id`,-1),`value`);