PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`label` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`imported_at` real NOT NULL,
	`category` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tags_category_check" CHECK("__new_tags"."category" IS NULL OR "__new_tags"."category" IN ('genre','certification','collection','quality','language','audio_language','user','custom'))
);
--> statement-breakpoint
INSERT INTO `__new_tags`("id", "app_id", "label", "count", "imported_at", "category") SELECT "id", "app_id", "label", "count", "imported_at", "category" FROM `tags`;--> statement-breakpoint
DROP TABLE `tags`;--> statement-breakpoint
ALTER TABLE `__new_tags` RENAME TO `tags`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tags_app_id_label_unique` ON `tags` (`app_id`,`label`);--> statement-breakpoint
CREATE TABLE `__new_vocabulary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`app_type` text NOT NULL,
	`app_id` integer,
	`value` text NOT NULL,
	`external_id` text,
	`source` text NOT NULL,
	`imported_at` real NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vocabulary_category_check" CHECK("__new_vocabulary"."category" IN ('genre','certification','collection','quality','language','audio_language')),
	CONSTRAINT "vocabulary_app_type_check" CHECK("__new_vocabulary"."app_type" IN ('radarr','sonarr')),
	CONSTRAINT "vocabulary_source_check" CHECK("__new_vocabulary"."source" IN ('tmdb','trash','instance','observed'))
);
--> statement-breakpoint
INSERT INTO `__new_vocabulary`("id", "category", "app_type", "app_id", "value", "external_id", "source", "imported_at") SELECT "id", "category", "app_type", "app_id", "value", "external_id", "source", "imported_at" FROM `vocabulary`;--> statement-breakpoint
DROP TABLE `vocabulary`;--> statement-breakpoint
ALTER TABLE `__new_vocabulary` RENAME TO `vocabulary`;--> statement-breakpoint
CREATE INDEX `idx_vocabulary_lookup` ON `vocabulary` (`category`,`app_type`,`app_id`);--> statement-breakpoint
-- Recreating `vocabulary` (CHECK constraint change) drops this hand-written
-- expression index too -- put it back, same as 0000_keen_logan.sql.
CREATE UNIQUE INDEX `idx_vocabulary_unique` ON `vocabulary` (`category`,`app_type`,coalesce(`app_id`,-1),`value`);--> statement-breakpoint
ALTER TABLE `app_items` ADD `audio_languages_json` text DEFAULT '[]' NOT NULL;