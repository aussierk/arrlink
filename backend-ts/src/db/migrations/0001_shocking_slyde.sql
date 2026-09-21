PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`app_scope` integer,
	`app_type_scope` text,
	`conditions_json` text DEFAULT '[]' NOT NULL,
	`dir_template` text NOT NULL,
	`filename_template` text,
	`dir_naming_mode` text DEFAULT 'source' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`unlink_on_mismatch` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` real DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`app_scope`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "rules_dir_naming_mode_check" CHECK("__new_rules"."dir_naming_mode" IN ('source', 'custom'))
);
--> statement-breakpoint
INSERT INTO `__new_rules`("id", "name", "app_scope", "app_type_scope", "conditions_json", "dir_template", "filename_template", "enabled", "unlink_on_mismatch", "priority", "created_at") SELECT "id", "name", "app_scope", "app_type_scope", "conditions_json", "dir_template", "filename_template", "enabled", "unlink_on_mismatch", "priority", "created_at" FROM `rules`;--> statement-breakpoint
DROP TABLE `rules`;--> statement-breakpoint
ALTER TABLE `__new_rules` RENAME TO `rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;